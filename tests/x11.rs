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
