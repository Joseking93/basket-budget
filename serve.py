"""Local static server for the tracker.

Why not `python -m http.server`: it serves files with no cache directives, so the
browser caches the JS modules and keeps running old code after an edit. Reloading
does not reliably help — `location.reload(true)` does not bust ES module imports —
so a fixed bug appears unfixed, which is the worst kind of wrong.

This sends `Cache-Control: no-store` on everything, so a plain refresh always gets
the current code. Binds to 127.0.0.1 only: nothing is exposed to the network.
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quiet: one line per asset makes the console useless for real errors.
        if '"GET' in (fmt % args) and ' 200 ' in (fmt % args):
            return
        super().log_message(fmt, *args)


if __name__ == '__main__':
    # One copy of the web app: the folder the APK ships as its assets.
    here = os.path.dirname(os.path.abspath(__file__))
    handler = partial(NoCacheHandler, directory=os.path.join(here, 'app', 'src', 'main', 'assets'))
    with ThreadingHTTPServer(('127.0.0.1', PORT), handler) as httpd:
        print(f'M-PESA Tracker serving on http://localhost:{PORT}  (Ctrl+C to stop)')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
