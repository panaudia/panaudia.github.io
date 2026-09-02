# panaudia.com

The panaudia.com front page, served by GitHub Pages. One static
page about LASA, plus a 404.

This is now the source of truth for the page. It began as a render
of `lark_audio/.../templates/lasa.html` (Flask, retired 2026-09)
with the six `url_for` calls replaced by plain paths; edit the HTML
and CSS here directly.

Layout:

    index.html          the page
    404.html            everything else
    CNAME               panaudia.com, read by GitHub Pages
    css/lasa.css        the whole stylesheet, fonts declared at the top
    fonts/              Quicksand (variable), Source Code Pro
    images/             favicon and the waveform mark
    demo/               the live demo (plan: lasa-planning
                        plan/live-demo-page.md); demo/js/lasa-client/
                        index.js is the built @panaudia/lasa-client,
                        copied from lasa/typescript/dist/index.js —
                        refresh it by hand on a client release.
                        demo/coi-serviceworker.js is vendored
                        (gzuidhof/coi-serviceworker, MIT).
    demo/square/        the 3D town square on the same space
                        (three.js, vendored under demo/square/js/
                        three). Head tracking uses voltface
                        (demo/square/js/voltface, the built module
                        copied from the voltface repo) on top of
                        MediaPipe, which is NOT vendored: see below.

Head tracking on the town square loads MediaPipe from third-party
hosts rather than this repo. The runtime (about 12 MB of wasm) is
too big to want in git, so the import map in demo/square/index.html
and the paths in demo/square/start.js point at

    https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/
    https://storage.googleapis.com/mediapipe-models/face_landmarker/...

Nothing is fetched until a visitor clicks "Head tracking", and both
hosts send CORS headers, so the loads work under the page's
cross-origin isolation (verified 2026-09-02). The version pin must
match in index.html and start.js, and must stay at what the vendored
voltface was built against. If either host goes away, only head
tracking breaks; joining and audio are unaffected.

To view locally:

    python3 -m http.server -d . 8000

Deploying is `git push`; GitHub Pages serves the root of `main`.
The visual system (navy `#18334b`, teal accent `#6fc9d8`, Quicksand
for display only) is described in `lasa-planning`.
