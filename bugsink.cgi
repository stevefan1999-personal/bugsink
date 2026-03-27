#!/usr/bin/env python
"""
CGI entry point for Bugsink on LiteSpeed/cPanel shared hosting.

LiteSpeed does not support Passenger Python WSGI. This script runs Django
as a plain CGI application — no special server modules needed.

Setup:
  1. Copy this file to the domain's cgi-bin/:
       cp repositories/bugsink/bugsink.cgi ~/gracious-blue-panda.../cgi-bin/bugsink.cgi
  2. Make it executable:  chmod 755 ~/gracious-blue-panda.../cgi-bin/bugsink.cgi
  3. Edit the shebang (first line) to point to your virtualenv Python:
       #!/home/USERNAME/virtualenv/repositories/bugsink/3.13/bin/python
  4. Add the .htaccess rewrite rules (see below).
  5. Run migrations via cPanel "Execute python script": manage.py migrate

Note: CGI spawns Python per request. It's slow (~1s per page) but functional.
"""

import os
import sys

# App directory: auto-detect from this script's location, or override via env var.
APP_DIR = os.environ.get("BUGSINK_APP_DIR", os.path.dirname(os.path.abspath(__file__)))

sys.path.insert(0, APP_DIR)
os.chdir(APP_DIR)

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "bugsink.settings.passenger")

from wsgiref.handlers import CGIHandler
from bugsink.wsgi import application as _application


class CGIPathFix:
    """Fix PATH_INFO / SCRIPT_NAME for CGI behind mod_rewrite."""

    def __init__(self, app):
        self.app = app

    def __call__(self, environ, start_response):
        # mod_rewrite sets SCRIPT_NAME to the CGI script path and PATH_INFO to
        # the remainder.  Django needs SCRIPT_NAME="" and PATH_INFO="/the/url".
        script = environ.get("SCRIPT_NAME", "")
        if "/cgi-bin/" in script:
            environ["SCRIPT_NAME"] = ""
        return self.app(environ, start_response)


CGIHandler().run(CGIPathFix(_application))
