"""
Phusion Passenger WSGI entry point for Bugsink.

This file is used when deploying Bugsink on shared hosting (e.g. cPanel) with Phusion Passenger.
Passenger discovers this file by name and imports the `application` callable from it.

cPanel's "Setup Python App" fields map as follows:
  - Application root:        the directory containing this file
  - Application startup file: passenger_wsgi.py  (this file)
  - Application entry point:  application        (the WSGI callable below)
"""

import fcntl
import logging
import os
import sys

# Ensure the project root is on sys.path so Django can find the bugsink package.
project_root = os.path.dirname(os.path.abspath(__file__))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "bugsink.settings.passenger")

from bugsink.wsgi import application as _application  # noqa: E402
from urllib.parse import unquote
from django.conf import settings
from django.core.management import call_command

logger = logging.getLogger("bugsink.passenger")


# ---------------------------------------------------------------------------
# Auto-initialise the database on first startup.
#
# Passenger may spawn multiple worker processes; a file lock ensures only one
# process runs migrations at a time.  Django's migrate is idempotent, so if
# another worker already ran it, the second invocation is a fast no-op.
# ---------------------------------------------------------------------------

def _auto_init():
    """Run migrations + prestart once, guarded by a file lock."""

    lock_path = os.path.join(settings.BASE_DIR, ".passenger_init.lock")
    try:
        lock_fd = open(lock_path, "w")
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        # Another worker already holds the lock — skip, it will handle init.
        return

    try:

        logger.info("Running database migrations (default)...")
        call_command("migrate", verbosity=1, no_color=True)

        logger.info("Running database migrations (snappea)...")
        call_command("migrate", "snappea", database="snappea", verbosity=1, no_color=True)

        logger.info("Running prestart tasks...")
        call_command("prestart")

        logger.info("Auto-init complete.")
    except Exception:
        logger.exception("Auto-init failed — the application may not work correctly.")
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()
        try:
            os.unlink(lock_path)
        except OSError:
            pass


_auto_init()


# ---------------------------------------------------------------------------
# WSGI middleware
# ---------------------------------------------------------------------------

class PassengerPathInfoFix:
    """
    Passenger sometimes does not set PATH_INFO correctly (or sets SCRIPT_NAME to the app root),
    which causes Django's URL routing to break. This middleware normalises both variables using
    REQUEST_URI, which Passenger always populates reliably.
    """

    def __init__(self, app):
        self.app = app

    def __call__(self, environ, start_response):
        # Clear SCRIPT_NAME so Django doesn't think the app is mounted at a sub-path
        # (unless FORCE_SCRIPT_NAME is set in Django settings, which takes precedence).
        environ["SCRIPT_NAME"] = ""

        request_uri = unquote(environ.get("REQUEST_URI", environ.get("PATH_INFO", "/")))
        if "?" in request_uri:
            request_uri = request_uri.split("?", 1)[0]
        environ["PATH_INFO"] = request_uri

        return self.app(environ, start_response)


application = PassengerPathInfoFix(_application)
