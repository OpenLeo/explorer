#!/usr/bin/env python3
"""
Static file server with directory listings AND CORS headers, so the explorer can load
repositories served on another port (python3 -m http.server does not send CORS headers).

Usage: python3 tools/serve.py [PORT] [DIRECTORY]      (default: 8000, current directory)
Easiest setup is still one server for everything: run it (or python3 -m http.server)
from the folder containing openleo-explorer/ and the repositories.
"""
import functools
import http.server
import sys


class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    directory = sys.argv[2] if len(sys.argv) > 2 else '.'
    handler = functools.partial(CORSHandler, directory=directory)
    with http.server.ThreadingHTTPServer(('', port), handler) as srv:
        print(f'Serving {directory} on http://localhost:{port}/ (CORS enabled)')
        srv.serve_forever()


if __name__ == '__main__':
    main()
