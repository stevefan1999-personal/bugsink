"""
LiteSpeed Web Server startup script for Bugsink.

LiteSpeed uses PassengerAppStartCommand to start apps. It assigns a dynamic
port via the PORT environment variable. This script runs auto-init (migrations
+ superuser creation) then starts gunicorn on that port.

.htaccess usage:
  PassengerAppStartCommand "python start_lsws.py"
"""

import os
import sys

project_root = os.path.dirname(os.path.abspath(__file__))
os.chdir(project_root)
if project_root not in sys.path:
    sys.path.insert(0, project_root)

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "bugsink.settings.passenger")

# Trigger Django setup + auto-init (migrations, superuser creation)
import passenger_wsgi  # noqa: F401 — side effect: runs _auto_init()

# Start gunicorn on the port LiteSpeed assigns
port = os.environ.get("PORT", "8000")
gunicorn_bin = os.path.join(os.path.dirname(sys.executable), "gunicorn")

os.execv(gunicorn_bin, [
    "gunicorn",
    "--bind", "127.0.0.1:%s" % port,
    "--workers", "2",
    "--access-logfile", "-",
    "bugsink.wsgi:application",
])
