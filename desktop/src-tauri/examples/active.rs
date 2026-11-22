// Diagnostic: prints what Observe would read for the window in front. Run under a desktop session.
fn main() {
    match active_win_pos_rs::get_active_window() {
        Ok(w) => println!("app={:?} title={:?} window_id={}", w.app_name, w.title, w.window_id),
        Err(e) => println!("ERR {e:?}"),
    }
}
