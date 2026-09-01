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

To view locally:

    python3 -m http.server -d . 8000

Deploying is `git push`; GitHub Pages serves the root of `main`.
The visual system (navy `#18334b`, teal accent `#6fc9d8`, Quicksand
for display only) is described in `lasa-planning`.
