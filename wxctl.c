/* wxctl - minimal X11 automation helper (xdotool-lite) for WeChat on Linux
 * build: gcc -O2 -o wxctl wxctl.c -lX11 -lXtst
 * usage:
 *   wxctl find                      list candidate windows (class contains arg)
 *   wxctl activate <winid>          raise + activate window
 *   wxctl key <combo>               e.g. ctrl+v, Return, ctrl+shift+f
 *   wxctl type <ascii>              type ascii text
 *   wxctl clip <seconds> <text>     own CLIPBOARD with text for N seconds (daemonizes)
 *   wxctl shot <winid|root> <ppm>   save screenshot as PPM
 */
#define _GNU_SOURCE
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <X11/XKBlib.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include <fcntl.h>

static Display *dpy;

static void die(const char *m) { fprintf(stderr, "wxctl: %s\n", m); exit(1); }

static int class_matches(Window w, const char *want) {
    XClassHint ch;
    if (XGetClassHint(dpy, w, &ch)) {
        int m = (ch.res_class && strcasestr(ch.res_class, want)) ||
                (ch.res_name && strcasestr(ch.res_name, want));
        if (ch.res_name) XFree(ch.res_name);
        if (ch.res_class) XFree(ch.res_class);
        return m;
    }
    return 0;
}

static void list_windows(Window w, const char *want, int depth) {
    Window root, parent, *kids = NULL;
    unsigned int n = 0;
    if (!XQueryTree(dpy, w, &root, &parent, &kids, &n)) return;
    for (unsigned int i = 0; i < n; i++) {
        XWindowAttributes a;
        if (XGetWindowAttributes(dpy, kids[i], &a) && a.map_state == IsViewable) {
            char *nm = NULL;
            int by_name = 0;
            if (XFetchName(dpy, kids[i], &nm) && nm) by_name = strcasestr(nm, want) != NULL;
            if (nm) XFree(nm);
            if (by_name || class_matches(kids[i], want)) {
                char *name = NULL;
                XFetchName(dpy, kids[i], &name);
                printf("0x%08lx %4dx%-4d +%d+%d  class=%-16s name=%s\n",
                       kids[i], a.width, a.height, a.x, a.y,
                       "?", name ? name : "(none)");
                if (name) XFree(name);
            }
        }
        list_windows(kids[i], want, depth + 1);
    }
    if (kids) XFree(kids);
}

static void activate(Window w) {
    XEvent ev;
    memset(&ev, 0, sizeof(ev));
    ev.xclient.type = ClientMessage;
    ev.xclient.window = w;
    ev.xclient.message_type = XInternAtom(dpy, "_NET_ACTIVE_WINDOW", False);
    ev.xclient.format = 32;
    ev.xclient.data.l[0] = 2; /* source: pager */
    ev.xclient.data.l[1] = CurrentTime;
    XSendEvent(dpy, DefaultRootWindow(dpy), False,
               SubstructureRedirectMask | SubstructureNotifyMask, &ev);
    XRaiseWindow(dpy, w);
    XSetInputFocus(dpy, w, RevertToParent, CurrentTime);
    XFlush(dpy);
    usleep(300000);
}

static KeyCode key_of(const char *tok) {
    KeySym ks;
    if (!strcasecmp(tok, "ctrl") || !strcasecmp(tok, "control")) ks = XK_Control_L;
    else if (!strcasecmp(tok, "shift")) ks = XK_Shift_L;
    else if (!strcasecmp(tok, "alt")) ks = XK_Alt_L;
    else if (!strcasecmp(tok, "super") || !strcasecmp(tok, "win")) ks = XK_Super_L;
    else ks = XStringToKeysym(tok);
    if (ks == NoSymbol) { fprintf(stderr, "wxctl: unknown key '%s'\n", tok); exit(1); }
    return XKeysymToKeycode(dpy, ks);
}

static void press(KeyCode kc, int down) {
    XTestFakeKeyEvent(dpy, kc, down, 0);
    XFlush(dpy);
    usleep(12000);
}

static void send_key(const char *spec) {
    char buf[256];
    snprintf(buf, sizeof(buf), "%s", spec);
    KeyCode mods[8];
    int nm = 0;
    char *tok, *save = NULL;
    char *last = NULL;
    for (tok = strtok_r(buf, "+", &save); tok; tok = strtok_r(NULL, "+", &save)) last = tok;
    if (!last) die("empty key spec");
    /* modifiers are all tokens before the last one */
    snprintf(buf, sizeof(buf), "%s", spec);
    save = NULL;
    for (tok = strtok_r(buf, "+", &save); tok && tok != last; tok = strtok_r(NULL, "+", &save)) {
        if (nm < 8) mods[nm++] = key_of(tok);
    }
    KeyCode kc = key_of(last);
    for (int i = 0; i < nm; i++) press(mods[i], 1);
    press(kc, 1);
    press(kc, 0);
    for (int i = nm - 1; i >= 0; i--) press(mods[i], 0);
    XFlush(dpy);
}

static void type_text(const char *s) {
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '\n') { send_key("Return"); continue; }
        if (c == '\t') { send_key("Tab"); continue; }
        if (c == ' ') { send_key("space"); continue; }
        char name[2] = { (char)c, 0 };
        KeySym ks = XStringToKeysym(name);
        if (ks == NoSymbol) continue;
        KeyCode kc = XKeysymToKeycode(dpy, ks);
        if (!kc) continue;
        KeySym base = XkbKeycodeToKeysym(dpy, kc, 0, 0);
        char spec[16];
        if (base != ks) snprintf(spec, sizeof spec, "shift+%s", name);
        else snprintf(spec, sizeof spec, "%s", name);
        send_key(spec);
    }
}


static void click(Window w, int x, int y, int button) {
    int rx = x, ry = y;
    Window child;
    XTranslateCoordinates(dpy, w, DefaultRootWindow(dpy), x, y, &rx, &ry, &child);
    XTestFakeMotionEvent(dpy, -1, rx, ry, 0);
    XFlush(dpy);
    usleep(60000);
    XTestFakeButtonEvent(dpy, button, True, 0);
    XFlush(dpy);
    usleep(40000);
    XTestFakeButtonEvent(dpy, button, False, 0);
    XFlush(dpy);
    usleep(40000);
    printf("clicked %d,%d (root %d,%d) button %d\n", x, y, rx, ry, button);
}

static void shot(Window w, const char *path) {
    XWindowAttributes a;
    if (!XGetWindowAttributes(dpy, w, &a)) die("bad window");
    XImage *img = XGetImage(dpy, w, 0, 0, a.width, a.height, AllPlanes, ZPixmap);
    if (!img) die("XGetImage failed");
    FILE *f = fopen(path, "wb");
    if (!f) die("open output failed");
    fprintf(f, "P6\n%d %d\n255\n", a.width, a.height);
    for (int y = 0; y < a.height; y++)
        for (int x = 0; x < a.width; x++) {
            unsigned long p = XGetPixel(img, x, y);
            unsigned char rgb[3] = { (p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff };
            fwrite(rgb, 1, 3, f);
        }
    fclose(f);
    XDestroyImage(img);
    printf("saved %s (%dx%d)\n", path, a.width, a.height);
}

/* ---------- clipboard owner ---------- */
static Window clipwin;
static char *cliptext;

static void serve_selection(void) {
    Atom CLIPBOARD = XInternAtom(dpy, "CLIPBOARD", False);
    Atom TARGETS = XInternAtom(dpy, "TARGETS", False);
    Atom UTF8 = XInternAtom(dpy, "UTF8_STRING", False);
    Atom TEXT = XInternAtom(dpy, "TEXT", False);
    Atom STRING = XA_STRING;
    for (;;) {
        while (XPending(dpy)) {
            XEvent ev;
            XNextEvent(dpy, &ev);
            if (ev.type != SelectionRequest) continue;
            XSelectionRequestEvent *r = &ev.xselectionrequest;
            XSelectionEvent resp;
            memset(&resp, 0, sizeof(resp));
            resp.type = SelectionNotify;
            resp.display = dpy;
            resp.requestor = r->requestor;
            resp.selection = r->selection;
            resp.target = r->target;
            resp.time = r->time;
            resp.property = None;
            if (r->target == TARGETS) {
                Atom avail[4] = { UTF8, STRING, TEXT, TARGETS };
                XChangeProperty(dpy, r->requestor, r->property, XA_ATOM, 32,
                                PropModeReplace, (unsigned char *)avail, 4);
                resp.property = r->property;
            } else if (r->target == UTF8 || r->target == STRING || r->target == TEXT) {
                XChangeProperty(dpy, r->requestor, r->property, r->target, 8,
                                PropModeReplace, (unsigned char *)cliptext, (int)strlen(cliptext));
                resp.property = r->property;
            }
            XSendEvent(dpy, r->requestor, False, 0, (XEvent *)&resp);
            XFlush(dpy);
        }
        usleep(15000);
    }
}

int main(int argc, char **argv) {
    if (argc < 2) die("usage: wxctl <find|activate|key|type|clip|shot> ...");
    dpy = XOpenDisplay(NULL);
    if (!dpy) die("cannot open display");
    const char *cmd = argv[1];

    if (!strcmp(cmd, "find")) {
        list_windows(DefaultRootWindow(dpy), argc > 2 ? argv[2] : "wechat", 0);
    } else if (!strcmp(cmd, "activate")) {
        if (argc < 3) die("need window id");
        activate((Window)strtoul(argv[2], NULL, 0));
        printf("activated 0x%lx\n", (unsigned long)strtoul(argv[2], NULL, 0));
    } else if (!strcmp(cmd, "key")) {
        if (argc < 3) die("need key combo");
        send_key(argv[2]);
        printf("sent key %s\n", argv[2]);
    } else if (!strcmp(cmd, "type")) {
        if (argc < 3) die("need text");
        type_text(argv[2]);
    } else if (!strcmp(cmd, "clip")) {
        if (argc < 4) die("need seconds and text");
        int secs = atoi(argv[2]);
        cliptext = argv[3];
        pid_t pid = fork();
        if (pid < 0) die("fork failed");
        if (pid > 0) { printf("clipboard owner pid %d for %ds\n", pid, secs); return 0; }
        setsid();
        {
            int devnull = open("/dev/null", O_RDWR);
            if (devnull >= 0) {
                dup2(devnull, 0); dup2(devnull, 1); dup2(devnull, 2);
                if (devnull > 2) close(devnull);
            }
        }
        clipwin = XCreateSimpleWindow(dpy, DefaultRootWindow(dpy), -10, -10, 1, 1, 0, 0, 0);
        Atom CLIPBOARD = XInternAtom(dpy, "CLIPBOARD", False);
        XSetSelectionOwner(dpy, CLIPBOARD, clipwin, CurrentTime);
        XFlush(dpy);
        if (XGetSelectionOwner(dpy, CLIPBOARD) != clipwin) die("could not own CLIPBOARD");
        signal(SIGTERM, SIG_DFL);
        alarm((unsigned)secs);
        signal(SIGALRM, SIG_DFL);
        serve_selection();
    } else if (!strcmp(cmd, "click")) {
        if (argc < 5) die("need winid x y [button]");
        click((Window)strtoul(argv[2], NULL, 0), atoi(argv[3]), atoi(argv[4]),
              argc > 5 ? atoi(argv[5]) : 1);
    } else if (!strcmp(cmd, "geom")) {
        if (argc < 3) die("need window id");
        Window w = (Window)strtoul(argv[2], NULL, 0);
        XWindowAttributes a;
        int rx = 0, ry = 0;
        Window child;
        if (!XGetWindowAttributes(dpy, w, &a)) die("bad window");
        XTranslateCoordinates(dpy, w, DefaultRootWindow(dpy), 0, 0, &rx, &ry, &child);
        printf("%d %d %d %d\n", rx, ry, a.width, a.height);
    } else if (!strcmp(cmd, "shot")) {
        if (argc < 4) die("need window id and output path");
        Window w = strcmp(argv[2], "root") ? (Window)strtoul(argv[2], NULL, 0) : DefaultRootWindow(dpy);
        shot(w, argv[3]);
    } else die("unknown command");
    XCloseDisplay(dpy);
    return 0;
}
