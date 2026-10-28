#![forbid(unsafe_code)]

use std::{
    env,
    error::Error,
    fs,
    process::Command,
    thread::sleep,
    time::{Duration, Instant},
};
use x11rb::{
    connection::Connection,
    protocol::{xproto::*, Event},
    wrapper::ConnectionExt as _,
    CURRENT_TIME, NONE,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn run(args: &[&str]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_wxctl"))
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
#[ignore = "run only in an isolated Xvfb display"]
fn native_cli_window_input_clipboard_and_screenshot() -> Result<()> {
    let (conn, screen) = x11rb::connect(None)?;
    let root = conn.setup().roots[screen].root;
    let w = conn.generate_id()?;
    conn.create_window(
        0,
        w,
        root,
        50,
        70,
        320,
        240,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new()
            .background_pixel(0x336699)
            .event_mask(
                EventMask::KEY_PRESS
                    | EventMask::KEY_RELEASE
                    | EventMask::BUTTON_PRESS
                    | EventMask::BUTTON_RELEASE,
            ),
    )?
    .check()?;
    conn.change_property8(
        PropMode::REPLACE,
        w,
        AtomEnum::WM_CLASS,
        AtomEnum::STRING,
        b"WeixinFake\0Weixin\0",
    )?
    .check()?;
    conn.change_property8(
        PropMode::REPLACE,
        w,
        AtomEnum::WM_NAME,
        AtomEnum::STRING,
        b"Weixin Test",
    )?
    .check()?;
    conn.map_window(w)?.check()?;
    conn.flush()?;
    let id = format!("0x{w:x}");
    assert!(run(&["find", "Weixin"]).contains(&format!("0x{w:08x} 320x240")));
    assert_eq!(run(&["geom", &id]).trim(), "50 70 320 240");
    run(&["activate", &id]);
    run(&["key", "ctrl+a"]);
    run(&["type", "Aa+!?"]);
    run(&["click", &id, "25", "35"]);
    let pointer = conn.query_pointer(w)?.reply()?;
    assert_eq!((pointer.win_x, pointer.win_y), (25, 35));
    let mut control_combo = false;
    let mut shift_key = false;
    let mut click = false;
    conn.get_input_focus()?.reply()?; // Round-trip before draining queued events.
    while let Some(event) = conn.poll_for_event()? {
        match event {
            Event::KeyPress(e) => {
                control_combo |= e.state.contains(KeyButMask::CONTROL);
                shift_key |= e.state.contains(KeyButMask::SHIFT);
            }
            Event::ButtonPress(e) => click |= e.detail == 1 && e.event_x == 25 && e.event_y == 35,
            _ => {}
        }
    }
    assert!(
        control_combo && shift_key && click,
        "missing keyboard/mouse events"
    );
    assert_eq!(
        conn.query_keymap()?.reply()?.keys,
        [0; 32],
        "a key was left pressed"
    );

    let directory = env::temp_dir().join(format!("wxctl-x11-{}", std::process::id()));
    fs::create_dir_all(&directory)?;
    let shot = directory.join("window.ppm");
    run(&["shot", &id, shot.to_str().unwrap()]);
    let data = fs::read(&shot)?;
    let header = b"P6\n320 240\n255\n";
    assert!(data.starts_with(header));
    assert_eq!(data.len(), header.len() + 320 * 240 * 3);
    assert_eq!(&data[header.len()..header.len() + 3], &[0x33, 0x66, 0x99]);
    run(&["shot", "root", directory.join("root.ppm").to_str().unwrap()]);
    fs::remove_dir_all(directory)?;

    let clipboard = conn.intern_atom(false, b"CLIPBOARD")?.reply()?.atom;
    let utf8 = conn.intern_atom(false, b"UTF8_STRING")?.reply()?.atom;
    let property = conn.intern_atom(false, b"WXCTL_TEST")?.reply()?.atom;
    run(&["clip", "5", "你好 WeChat 🌊"]);
    assert_ne!(conn.get_selection_owner(clipboard)?.reply()?.owner, NONE);
    conn.convert_selection(w, clipboard, utf8, property, CURRENT_TIME)?
        .check()?;
    conn.flush()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut received = false;
    while Instant::now() < deadline {
        if let Some(Event::SelectionNotify(e)) = conn.poll_for_event()? {
            assert_ne!(e.property, NONE);
            let value = conn
                .get_property(false, w, property, utf8, 0, 1024)?
                .reply()?
                .value;
            assert_eq!(String::from_utf8(value)?, "你好 WeChat 🌊");
            received = true;
            break;
        }
        sleep(Duration::from_millis(10));
    }
    assert!(received, "clipboard conversion timed out");
    conn.set_selection_owner(NONE, clipboard, CURRENT_TIME)?
        .check()?;
    conn.destroy_window(w)?.check()?;
    Ok(())
}

#[test]
fn malformed_commands_exit_with_errors_without_a_display() {
    for args in [
        vec!["unknown"],
        vec!["click", "0x1"],
        vec!["clip", "0", "text"],
        vec!["clip", "oops", "text"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_wxctl"))
            .env_remove("DISPLAY")
            .args(&args)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "invalid command accepted: {args:?}"
        );
        assert!(String::from_utf8_lossy(&output.stderr).contains("wxctl:"));
    }
}
#[test]
#[ignore = "run only in an isolated Xvfb display with system python3-pil"]
fn python_image_capture_opens_a_real_mock_preview() -> Result<()> {
    use std::process::Stdio;
    let (conn, screen) = x11rb::connect(None)?;
    let root = conn.setup().roots[screen].root;
    let main = conn.generate_id()?;
    let preview = conn.generate_id()?;
    let gc = conn.generate_id()?;
    for (w, width, height, x, y) in [(main, 880, 640, 0, 0), (preview, 600, 420, 100, 80)] {
        conn.create_window(
            0,
            w,
            root,
            x,
            y,
            width,
            height,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new()
                .background_pixel(0xf5f5f5)
                .event_mask(EventMask::BUTTON_PRESS | EventMask::KEY_PRESS),
        )?
        .check()?;
        conn.change_property8(
            PropMode::REPLACE,
            w,
            AtomEnum::WM_CLASS,
            AtomEnum::STRING,
            b"WeixinMock\0Weixin\0",
        )?
        .check()?;
    }
    conn.create_gc(gc, main, &CreateGCAux::new())?.check()?;
    let gradient = |scale: usize| -> Vec<u8> {
        let mut pixels = Vec::new();
        for y in 0..140 * scale {
            for x in 0..200 * scale {
                let (x, y) = (x / scale, y / scale);
                let (r, g, b) = (
                    ((x * 3 + y) % 256) as u8,
                    ((x + y * 2) % 256) as u8,
                    ((x * 2 + y * 3) % 256) as u8,
                );
                pixels.extend_from_slice(&[b, g, r, 0]);
            }
        }
        pixels
    };
    conn.map_window(main)?.check()?;
    conn.put_image(
        ImageFormat::Z_PIXMAP,
        main,
        gc,
        200,
        140,
        356,
        320,
        0,
        24,
        &gradient(1),
    )?
    .check()?;
    conn.flush()?;
    let directory = env::temp_dir().join(format!("wxctl-media-{}", std::process::id()));
    fs::create_dir_all(&directory)?;
    let script = r#"
import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from PIL import Image
import wxread,wxmedia
from wxlock import display_lock
with display_lock():
 path=str(Path(sys.argv[3])/'main.ppm')
 wxread.shot(sys.argv[2],path)
 with Image.open(path) as image: bubbles=wxmedia.find_bubbles(image)
 assert len(bubbles)==1, f'expected one bubble, got {len(bubbles)}'
 print(wxmedia.capture_preview(sys.argv[2],bubbles[0],sys.argv[3]),flush=True)
"#;
    let mut child = Command::new("/usr/bin/python3")
        .args([
            "-c",
            script,
            &format!("{}/scripts", env!("CARGO_MANIFEST_DIR")),
            &format!("0x{main:x}"),
            directory.to_str().unwrap(),
        ])
        .env("WXCTL", env!("CARGO_BIN_EXE_wxctl"))
        .env("WX_DISPLAY", env::var("DISPLAY")?)
        .env("HOME", &directory)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut mapped = false;
    while child.try_wait()?.is_none() && Instant::now() < deadline {
        while let Some(event) = conn.poll_for_event()? {
            match event {
                Event::ButtonPress(e) if e.event == main && !mapped => {
                    conn.map_window(preview)?.check()?;
                    conn.put_image(
                        ImageFormat::Z_PIXMAP,
                        preview,
                        gc,
                        600,
                        420,
                        0,
                        0,
                        0,
                        24,
                        &gradient(3),
                    )?
                    .check()?;
                    conn.flush()?;
                    mapped = true;
                }
                Event::KeyPress(e) if e.event == preview => {
                    conn.unmap_window(preview)?.check()?;
                    conn.flush()?;
                }
                _ => {}
            }
        }
        sleep(Duration::from_millis(10));
    }
    if child.try_wait()?.is_none() {
        child.kill()?;
    }
    let output = child.wait_with_output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(mapped, "the mock application never opened a preview");
    let path = String::from_utf8(output.stdout)?.trim().to_owned();
    let data = fs::read(path)?;
    assert_eq!(&data[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
    assert!(data.len() > 1000);
    assert_eq!(
        conn.get_window_attributes(preview)?.reply()?.map_state,
        MapState::UNMAPPED
    );
    conn.destroy_window(main)?.check()?;
    conn.destroy_window(preview)?.check()?;
    fs::remove_dir_all(directory)?;
    Ok(())
}
