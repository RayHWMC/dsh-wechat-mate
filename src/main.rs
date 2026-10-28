#![forbid(unsafe_code)]

use std::{
    env,
    error::Error,
    fs::File,
    io::{self, BufRead, BufReader, BufWriter, Write},
    process::{Command, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};
use x11rb::{
    connection::Connection,
    protocol::{xproto::*, xtest::ConnectionExt as _, Event},
    rust_connection::RustConnection,
    wrapper::ConnectionExt as _,
    CURRENT_TIME, NONE,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn invalid(message: &str) -> Box<dyn Error> {
    io::Error::new(io::ErrorKind::InvalidInput, message).into()
}

fn window(value: &str) -> Result<Window> {
    let parsed = if let Some(hex) = value.strip_prefix("0x") {
        u32::from_str_radix(hex, 16)?
    } else {
        value.parse()?
    };
    if parsed == 0 {
        return Err(invalid("window ID must be nonzero"));
    }
    Ok(parsed)
}

fn key_symbol(name: &str) -> Result<u32> {
    let symbol = match name.to_ascii_lowercase().as_str() {
        "ctrl" | "control" | "control_l" => 0xffe3,
        "shift" | "shift_l" => 0xffe1,
        "alt" | "alt_l" => 0xffe9,
        "super" | "win" | "super_l" => 0xffeb,
        "backspace" => 0xff08,
        "tab" => 0xff09,
        "return" | "enter" => 0xff0d,
        "escape" | "esc" => 0xff1b,
        "delete" => 0xffff,
        "insert" => 0xff63,
        "home" => 0xff50,
        "end" => 0xff57,
        "left" => 0xff51,
        "up" => 0xff52,
        "right" => 0xff53,
        "down" => 0xff54,
        "pageup" | "prior" => 0xff55,
        "pagedown" | "next" => 0xff56,
        "space" => 0x20,
        "plus" => 0x2b,
        "minus" => 0x2d,
        _ if name.len() == 1 && name.is_ascii() => name.as_bytes()[0] as u32,
        _ => {
            if let Some(number) = name.strip_prefix('F').or_else(|| name.strip_prefix('f')) {
                if let Ok(n @ 1..=35) = number.parse::<u32>() {
                    return Ok(0xffbd + n);
                }
            }
            return Err(invalid(&format!("unknown key {name:?}")));
        }
    };
    Ok(symbol)
}

struct X11 {
    conn: RustConnection,
    screen: usize,
}

impl X11 {
    fn connect() -> Result<Self> {
        let (conn, screen) = x11rb::connect(None)?;
        Ok(Self { conn, screen })
    }
    fn root(&self) -> Window {
        self.conn.setup().roots[self.screen].root
    }
    fn atom(&self, name: &str) -> Result<Atom> {
        Ok(self.conn.intern_atom(false, name.as_bytes())?.reply()?.atom)
    }
    fn property(&self, w: Window, atom: Atom) -> Result<Vec<u8>> {
        Ok(self
            .conn
            .get_property(false, w, atom, AtomEnum::ANY, 0, 65536)?
            .reply()?
            .value)
    }
    fn find(&self, want: &str) -> Result<()> {
        let utf8_name = self.atom("_NET_WM_NAME")?;
        let mut stack = vec![self.root()];
        let want = want.to_lowercase();
        while let Some(parent) = stack.pop() {
            // Windows may disappear between querying the tree and inspecting a child.
            let tree = match self.conn.query_tree(parent)?.reply() {
                Ok(tree) => tree,
                Err(_) => continue,
            };
            for w in tree.children {
                stack.push(w);
                let a = match self.conn.get_window_attributes(w)?.reply() {
                    Ok(a) => a,
                    Err(_) => continue,
                };
                if a.map_state != MapState::VIEWABLE {
                    continue;
                }
                let class = self
                    .property(w, AtomEnum::WM_CLASS.into())
                    .unwrap_or_default();
                let title = self.property(w, utf8_name).unwrap_or_default();
                let title = if title.is_empty() {
                    self.property(w, AtomEnum::WM_NAME.into())
                        .unwrap_or_default()
                } else {
                    title
                };
                let class = String::from_utf8_lossy(&class).replace(['\0', '\n', '\r'], " ");
                let title = String::from_utf8_lossy(&title).replace(['\0', '\n', '\r'], " ");
                if !class.to_lowercase().contains(&want) && !title.to_lowercase().contains(&want) {
                    continue;
                }
                if let Ok(g) = self.conn.get_geometry(w)?.reply() {
                    println!(
                        "0x{w:08x} {}x{} +{}+{} class={} name={}",
                        g.width,
                        g.height,
                        g.x,
                        g.y,
                        class.trim(),
                        title
                    );
                }
            }
        }
        Ok(())
    }
    fn activate(&self, w: Window) -> Result<()> {
        let event = ClientMessageEvent::new(
            32,
            w,
            self.atom("_NET_ACTIVE_WINDOW")?,
            [2, CURRENT_TIME, 0, 0, 0],
        );
        self.conn
            .send_event(
                false,
                self.root(),
                EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                event,
            )?
            .check()?;
        self.conn
            .configure_window(w, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE))?
            .check()?;
        self.conn
            .set_input_focus(InputFocus::PARENT, w, CURRENT_TIME)?
            .check()?;
        self.conn.flush()?;
        sleep(Duration::from_millis(300));
        println!("activated 0x{w:x}");
        Ok(())
    }
    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<()> {
        self.conn
            .xtest_fake_input(kind, detail, CURRENT_TIME, self.root(), x, y, 0)?
            .check()?;
        self.conn.flush()?;
        sleep(Duration::from_millis(12));
        Ok(())
    }
    fn keycode(&self, symbol: u32) -> Result<(u8, bool)> {
        let setup = self.conn.setup();
        let count = setup.max_keycode - setup.min_keycode + 1;
        let mapping = self
            .conn
            .get_keyboard_mapping(setup.min_keycode, count)?
            .reply()?;
        let columns = usize::from(mapping.keysyms_per_keycode);
        if columns == 0 {
            return Err(invalid("empty keyboard mapping"));
        }
        for (index, row) in mapping.keysyms.chunks(columns).enumerate() {
            for (column, value) in row.iter().take(2).enumerate() {
                if *value == symbol {
                    return Ok((setup.min_keycode + index as u8, column == 1));
                }
            }
        }
        Err(invalid(&format!(
            "keysym 0x{symbol:x} is absent from the active keyboard layout"
        )))
    }
    fn stroke(&self, symbol: u32, modifiers: &[u32]) -> Result<()> {
        let (key, shifted) = self.keycode(symbol)?;
        let mut codes = Vec::new();
        for modifier in modifiers {
            codes.push(self.keycode(*modifier)?.0);
        }
        if shifted && !modifiers.contains(&0xffe1) {
            codes.push(self.keycode(0xffe1)?.0);
        }
        let result = (|| {
            for code in &codes {
                self.fake(KEY_PRESS_EVENT, *code, 0, 0)?;
            }
            self.fake(KEY_PRESS_EVENT, key, 0, 0)?;
            self.fake(KEY_RELEASE_EVENT, key, 0, 0)
        })();
        // Release modifiers even if the actual key request fails.
        for code in codes.iter().rev() {
            let _ = self.fake(KEY_RELEASE_EVENT, *code, 0, 0);
        }
        result
    }
    fn key(&self, spec: &str) -> Result<()> {
        let parts: Vec<_> = spec.split('+').collect();
        if parts.iter().any(|part| part.is_empty()) {
            return Err(invalid("empty key token; use 'plus' for +"));
        }
        let mut modifiers = Vec::new();
        for part in &parts[..parts.len() - 1] {
            let symbol = key_symbol(part)?;
            if ![0xffe3, 0xffe1, 0xffe9, 0xffeb].contains(&symbol) {
                return Err(invalid("only modifiers may precede the last key"));
            }
            if !modifiers.contains(&symbol) {
                modifiers.push(symbol);
            }
        }
        self.stroke(key_symbol(parts[parts.len() - 1])?, &modifiers)?;
        println!("sent key {spec}");
        Ok(())
    }
    fn type_text(&self, text: &str) -> Result<()> {
        if !text.is_ascii() {
            return Err(invalid(
                "type accepts ASCII only; use clip and ctrl+v for Unicode",
            ));
        }
        // Validate the entire text before producing input.
        let symbols: Vec<u32> = text
            .chars()
            .map(|c| match c {
                '\n' => 0xff0d,
                '\t' => 0xff09,
                _ => c as u32,
            })
            .collect();
        for symbol in &symbols {
            self.keycode(*symbol)?;
        }
        for symbol in symbols {
            self.stroke(symbol, &[])?;
        }
        Ok(())
    }
    fn click(&self, w: Window, x: i16, y: i16, button: u8) -> Result<()> {
        if !(1..=5).contains(&button) {
            return Err(invalid("button must be 1..5"));
        }
        let translated = self
            .conn
            .translate_coordinates(w, self.root(), x, y)?
            .reply()?;
        self.fake(MOTION_NOTIFY_EVENT, 0, translated.dst_x, translated.dst_y)?;
        self.fake(BUTTON_PRESS_EVENT, button, 0, 0)?;
        self.fake(BUTTON_RELEASE_EVENT, button, 0, 0)?;
        println!(
            "clicked {x},{y} (root {},{}) button {button}",
            translated.dst_x, translated.dst_y
        );
        Ok(())
    }
    fn geom(&self, w: Window) -> Result<()> {
        let g = self.conn.get_geometry(w)?.reply()?;
        let t = self
            .conn
            .translate_coordinates(w, self.root(), 0, 0)?
            .reply()?;
        println!("{} {} {} {}", t.dst_x, t.dst_y, g.width, g.height);
        Ok(())
    }
    fn shot(&self, w: Window, path: &str) -> Result<()> {
        let g = self.conn.get_geometry(w)?.reply()?;
        let image = self
            .conn
            .get_image(ImageFormat::Z_PIXMAP, w, 0, 0, g.width, g.height, u32::MAX)?
            .reply()?;
        let setup = self.conn.setup();
        let format = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == image.depth)
            .ok_or_else(|| invalid("unknown pixel depth"))?;
        let visual = setup
            .roots
            .iter()
            .flat_map(|s| &s.allowed_depths)
            .flat_map(|d| &d.visuals)
            .find(|v| v.visual_id == image.visual)
            .ok_or_else(|| invalid("unknown visual"))?;
        if visual.class != VisualClass::TRUE_COLOR {
            return Err(invalid("screenshot requires a TrueColor visual"));
        }
        let bytes = usize::from(format.bits_per_pixel) / 8;
        if !(1..=4).contains(&bytes) {
            return Err(invalid("unsupported pixel format"));
        }
        let pad = usize::from(format.scanline_pad);
        if pad == 0 {
            return Err(invalid("invalid scanline padding"));
        }
        let stride =
            (usize::from(g.width) * usize::from(format.bits_per_pixel)).div_ceil(pad) * pad / 8;
        if image.data.len() < stride * usize::from(g.height) {
            return Err(invalid("truncated image"));
        }
        let mut output = BufWriter::new(File::create(path)?);
        write!(output, "P6\n{} {}\n255\n", g.width, g.height)?;
        for row in image.data.chunks(stride).take(usize::from(g.height)) {
            for raw in row.chunks(bytes).take(usize::from(g.width)) {
                let pixel = pixel_value(raw, setup.image_byte_order == ImageOrder::LSB_FIRST);
                output.write_all(&[
                    channel(pixel, visual.red_mask),
                    channel(pixel, visual.green_mask),
                    channel(pixel, visual.blue_mask),
                ])?;
            }
        }
        output.flush()?;
        println!("saved {path} ({}x{})", g.width, g.height);
        Ok(())
    }
    fn clipboard(&self, seconds: u64, text: &str) -> Result<()> {
        let w = self.conn.generate_id()?;
        self.conn
            .create_window(
                0,
                w,
                self.root(),
                -10,
                -10,
                1,
                1,
                0,
                WindowClass::INPUT_OUTPUT,
                0,
                &CreateWindowAux::new(),
            )?
            .check()?;
        let clipboard = self.atom("CLIPBOARD")?;
        let targets = self.atom("TARGETS")?;
        let utf8 = self.atom("UTF8_STRING")?;
        let plain = self.atom("TEXT")?;
        self.conn
            .set_selection_owner(w, clipboard, CURRENT_TIME)?
            .check()?;
        self.conn.flush()?;
        if self.conn.get_selection_owner(clipboard)?.reply()?.owner != w {
            return Err(invalid("could not own CLIPBOARD"));
        }
        println!("ready");
        io::stdout().flush()?;
        let deadline = Instant::now() + Duration::from_secs(seconds);
        while Instant::now() < deadline {
            match self.conn.poll_for_event()? {
                Some(Event::SelectionClear(_)) => break,
                Some(Event::SelectionRequest(req)) => {
                    let property = if req.property == NONE {
                        req.target
                    } else {
                        req.property
                    };
                    let mut response_property = NONE;
                    if req.target == targets {
                        self.conn
                            .change_property32(
                                PropMode::REPLACE,
                                req.requestor,
                                property,
                                AtomEnum::ATOM,
                                &[targets, utf8, plain, AtomEnum::STRING.into()],
                            )?
                            .check()?;
                        response_property = property;
                    } else if req.target == utf8 || req.target == plain {
                        self.conn
                            .change_property8(
                                PropMode::REPLACE,
                                req.requestor,
                                property,
                                utf8,
                                text.as_bytes(),
                            )?
                            .check()?;
                        response_property = property;
                    } else if req.target == AtomEnum::STRING.into() {
                        let latin: Vec<u8> = text
                            .chars()
                            .map(|c| u8::try_from(c as u32).unwrap_or(b'?'))
                            .collect();
                        self.conn
                            .change_property8(
                                PropMode::REPLACE,
                                req.requestor,
                                property,
                                AtomEnum::STRING,
                                &latin,
                            )?
                            .check()?;
                        response_property = property;
                    }
                    self.conn
                        .send_event(
                            false,
                            req.requestor,
                            EventMask::NO_EVENT,
                            SelectionNotifyEvent {
                                response_type: SELECTION_NOTIFY_EVENT,
                                sequence: 0,
                                time: req.time,
                                requestor: req.requestor,
                                selection: req.selection,
                                target: req.target,
                                property: response_property,
                            },
                        )?
                        .check()?;
                    self.conn.flush()?;
                }
                Some(_) => {}
                None => sleep(Duration::from_millis(10)),
            }
        }
        self.conn.destroy_window(w)?.check()?;
        Ok(())
    }
}

fn channel(pixel: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let value = (pixel & mask) >> shift;
    ((u64::from(value) * 255) / u64::from(mask >> shift)) as u8
}

fn pixel_value(raw: &[u8], little_endian: bool) -> u32 {
    if little_endian {
        raw.iter()
            .enumerate()
            .fold(0, |n, (i, b)| n | (u32::from(*b) << (8 * i)))
    } else {
        raw.iter().fold(0, |n, b| (n << 8) | u32::from(*b))
    }
}

fn clip(seconds: &str, text: &str) -> Result<()> {
    let duration: u64 = seconds.parse()?;
    if !(1..=3600).contains(&duration) {
        return Err(invalid("clipboard duration must be 1..3600 seconds"));
    }
    let mut child = Command::new(env::current_exe()?)
        .args(["__clipboard", seconds, text])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut ready = String::new();
    BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| invalid("clipboard pipe unavailable"))?,
    )
    .read_line(&mut ready)?;
    if ready.trim() != "ready" {
        let _ = child.kill();
        let _ = child.wait();
        return Err(invalid("clipboard owner failed to initialize"));
    }
    println!("clipboard owner pid {} for {duration}s", child.id());
    Ok(())
}

fn run() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    if args.is_empty() || args == ["--help"] {
        println!("usage: wxctl find [class] | activate <win> | key <combo> | type <ascii> | clip <seconds> <text> | click <win> <x> <y> [button] | geom <win> | shot <win|root> <ppm>");
        return if args.is_empty() {
            Err(invalid("command required"))
        } else {
            Ok(())
        };
    }
    if let ["clip", seconds, text] = args.as_slice() {
        return clip(seconds, text);
    }
    // Reject malformed commands before opening a display.
    match args.as_slice() {
        ["find"]
        | ["find", _]
        | ["activate", _]
        | ["key", _]
        | ["type", _]
        | ["geom", _]
        | ["shot", _, _]
        | ["click", _, _, _]
        | ["click", _, _, _, _]
        | ["__clipboard", _, _] => {}
        _ => {
            return Err(invalid(
                "unknown command or wrong argument count; see --help",
            ))
        }
    }
    let x = X11::connect()?;
    match args.as_slice() {
        ["find"] => x.find("wechat"),
        ["find", want] => x.find(want),
        ["activate", w] => x.activate(window(w)?),
        ["key", spec] => x.key(spec),
        ["type", text] => x.type_text(text),
        ["geom", w] => x.geom(window(w)?),
        ["shot", w, path] => x.shot(if *w == "root" { x.root() } else { window(w)? }, path),
        ["click", w, a, b] => x.click(window(w)?, a.parse()?, b.parse()?, 1),
        ["click", w, a, b, button] => x.click(window(w)?, a.parse()?, b.parse()?, button.parse()?),
        ["__clipboard", seconds, text] => {
            let duration = seconds.parse()?;
            if !(1..=3600).contains(&duration) {
                return Err(invalid("invalid clipboard duration"));
            }
            x.clipboard(duration, text)
        }
        _ => unreachable!(),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("wxctl: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_bad_window_ids_and_preserves_hex_and_decimal() {
        assert_eq!(window("0x123").unwrap(), 291);
        assert_eq!(window("291").unwrap(), 291);
        for bad in ["0", "-1", "0x100000000", "abc"] {
            assert!(window(bad).is_err());
        }
    }
    #[test]
    fn key_aliases_and_invalid_symbols() {
        assert_eq!(key_symbol("ctrl").unwrap(), 0xffe3);
        assert_eq!(key_symbol("F12").unwrap(), 0xffc9);
        assert_eq!(key_symbol("A").unwrap(), 65);
        assert!(key_symbol("F36").is_err());
        assert!(key_symbol("未知").is_err());
    }
    #[test]
    fn screenshot_byte_order_and_color_masks() {
        assert_eq!(pixel_value(&[0x33, 0x22, 0x11, 0], true), 0x112233);
        assert_eq!(pixel_value(&[0, 0x11, 0x22, 0x33], false), 0x112233);
        assert_eq!(channel(0x112233, 0xff0000), 0x11);
        assert_eq!(channel(0xf800, 0xf800), 255);
        assert_eq!(channel(0, 0), 0);
    }
}
