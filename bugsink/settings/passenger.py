"""
Django settings for Bugsink on cPanel / Phusion Passenger shared hosting.

All configuration is read from environment variables set in cPanel's
"Setup Python App" → "Environment variables" → "Add variable".

Required:
    BUGSINK_DOMAIN          yourdomain.com

Database (engine: mysql, mariadb, postgresql, postgres, or sqlite3):
    BUGSINK_DB_ENGINE       mysql
    BUGSINK_DB_NAME         cpaneluser_bugsink
    BUGSINK_DB_USER         cpaneluser_dbuser
    BUGSINK_DB_PASSWORD     your_db_password
    BUGSINK_DB_HOST         localhost              (optional, default: localhost)
    BUGSINK_DB_PORT         3306                   (optional, default: auto)

Admin account (created once, when zero users exist):
    CREATE_SUPERUSER        admin:yourpassword

Optional:
    BUGSINK_SECRET_KEY      (auto-generated if not set)
    BUGSINK_TIMEZONE        UTC
    BUGSINK_SITE_TITLE      Bugsink
    BUGSINK_SINGLE_USER     false                  (true = hide team/user management)
    BUGSINK_SINGLE_TEAM     false                  (true = one team, all projects in it)
    BUGSINK_MINIMIZE_INFO   false                  (true = reduce UI information exposure)
    BUGSINK_SESSION_SECURE  true                   (false if not using HTTPS)
    BUGSINK_CSRF_SECURE     true                   (false if not using HTTPS)
    BUGSINK_USE_X_REAL_IP   false                  (true if behind a proxy that sets X-Real-IP)
    BUGSINK_USE_X_FWD_FOR   false                  (true if behind a proxy that sets X-Forwarded-For)
    BUGSINK_X_FWD_FOR_COUNT 0                      (number of proxies in the chain)
    BUGSINK_TASK_EAGER      true                   (false to use background worker)
    BUGSINK_NUM_WORKERS     2                      (snappea worker count)
    BUGSINK_EMAIL_HOST      mail.yourdomain.com    (enables SMTP)
    BUGSINK_EMAIL_PORT      465
    BUGSINK_EMAIL_USER      bugsink@yourdomain.com
    BUGSINK_EMAIL_PASSWORD  ...
    SENTRY_DSN              (optional dogfooding)
"""

import os
import random
import string

from bugsink.settings.default import *  # noqa
from bugsink.conf_utils import deduce_allowed_hosts, eat_your_own_dogfood, deduce_script_name


# ---------------------------------------------------------------------------
# Secret key — auto-generated and persisted to a file if not in env
# ---------------------------------------------------------------------------
def _get_or_create_secret_key():
    key = os.environ.get("BUGSINK_SECRET_KEY")
    if key:
        return key

    key_file = os.path.join(BASE_DIR, ".bugsink_secret_key")
    try:
        with open(key_file) as f:
            return f.read().strip()
    except FileNotFoundError:
        pass

    chars = string.ascii_letters + string.digits + string.punctuation
    key = "".join(random.SystemRandom().choice(chars) for _ in range(50))
    with open(key_file, "w") as f:
        f.write(key)
    return key


SECRET_KEY = _get_or_create_secret_key()


# ---------------------------------------------------------------------------
# Domain
# ---------------------------------------------------------------------------
_DOMAIN = os.environ.get("BUGSINK_DOMAIN", "localhost")


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
_DB_ENGINE = os.environ.get("BUGSINK_DB_ENGINE", "sqlite3").lower()

_ENGINE_MAP = {
    "mysql":      "django.db.backends.mysql",
    "mariadb":    "django.db.backends.mysql",
    "postgresql": "django.db.backends.postgresql",
    "postgres":   "django.db.backends.postgresql",
    "sqlite3":    "bugsink.timed_sqlite_backend",
    "sqlite":     "bugsink.timed_sqlite_backend",
}

_DEFAULT_PORTS = {
    "mysql": "3306",
    "mariadb": "3306",
    "postgresql": "5432",
    "postgres": "5432",
}

if _DB_ENGINE in ("mysql", "mariadb"):
    import pymysql
    pymysql.install_as_MySQLdb()

if _DB_ENGINE in ("sqlite3", "sqlite"):
    DATABASES["default"]["NAME"] = os.path.join(BASE_DIR, "db.sqlite3")
else:
    DATABASES["default"] = {
        "ENGINE":   _ENGINE_MAP[_DB_ENGINE],
        "NAME":     os.environ.get("BUGSINK_DB_NAME", "bugsink"),
        "USER":     os.environ.get("BUGSINK_DB_USER", ""),
        "PASSWORD": os.environ.get("BUGSINK_DB_PASSWORD", ""),
        "HOST":     os.environ.get("BUGSINK_DB_HOST", "localhost"),
        "PORT":     os.environ.get("BUGSINK_DB_PORT", _DEFAULT_PORTS.get(_DB_ENGINE, "")),
    }
    if _DB_ENGINE in ("mysql", "mariadb"):
        DATABASES["default"]["OPTIONS"] = {"charset": "utf8mb4"}

# Snappea task-queue database (always SQLite).
DATABASES["snappea"]["NAME"] = os.path.join(BASE_DIR, "snappea.sqlite3")


def _envbool(name, default="false"):
    return os.environ.get(name, default).lower() in ("true", "1", "yes")


# ---------------------------------------------------------------------------
# SSL / proxy
# ---------------------------------------------------------------------------
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = _envbool("BUGSINK_SESSION_SECURE", "true")
CSRF_COOKIE_SECURE = _envbool("BUGSINK_CSRF_SECURE", "true")
CSRF_TRUSTED_ORIGINS = ["https://%s" % _DOMAIN, "http://%s" % _DOMAIN]
USE_X_REAL_IP = _envbool("BUGSINK_USE_X_REAL_IP", "false")
USE_X_FORWARDED_FOR = _envbool("BUGSINK_USE_X_FWD_FOR", "false")
X_FORWARDED_FOR_PROXY_COUNT = int(os.environ.get("BUGSINK_X_FWD_FOR_COUNT", "0"))


# ---------------------------------------------------------------------------
# Background tasks — synchronous on shared hosting by default
# ---------------------------------------------------------------------------
SNAPPEA = {
    "TASK_ALWAYS_EAGER": _envbool("BUGSINK_TASK_EAGER", "true"),
    "NUM_WORKERS": int(os.environ.get("BUGSINK_NUM_WORKERS", "2")),
    "PID_FILE": None,
    "WAKEUP_CALLS_DIR": os.path.join(BASE_DIR, "snappea", "wakeup"),
    "STATS_RETENTION_MINUTES": 60 * 24 * 7,
}


# ---------------------------------------------------------------------------
# Email — auto-enables SMTP when BUGSINK_EMAIL_HOST is set
# ---------------------------------------------------------------------------
EMAIL_BACKEND = "bugsink.email_backends.QuietConsoleEmailBackend"

if os.environ.get("BUGSINK_EMAIL_HOST"):
    EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
    EMAIL_HOST = os.environ["BUGSINK_EMAIL_HOST"]
    EMAIL_PORT = int(os.environ.get("BUGSINK_EMAIL_PORT", "465"))
    EMAIL_USE_SSL = os.environ.get("BUGSINK_EMAIL_USE_SSL", "true").lower() in ("true", "1", "yes")
    EMAIL_HOST_USER = os.environ.get("BUGSINK_EMAIL_USER", "")
    EMAIL_HOST_PASSWORD = os.environ.get("BUGSINK_EMAIL_PASSWORD", "")

SERVER_EMAIL = DEFAULT_FROM_EMAIL = "Bugsink <bugsink@%s>" % _DOMAIN


# ---------------------------------------------------------------------------
# Dogfooding
# ---------------------------------------------------------------------------
SENTRY_DSN = os.environ.get("SENTRY_DSN", None)
eat_your_own_dogfood(SENTRY_DSN)

TIME_ZONE = os.environ.get("BUGSINK_TIMEZONE", "UTC")


# ---------------------------------------------------------------------------
# Bugsink application settings
# ---------------------------------------------------------------------------
CB_ANYBODY = "CB_ANYBODY"
CB_MEMBERS = "CB_MEMBERS"
CB_ADMINS = "CB_ADMINS"
CB_NOBODY = "CB_NOBODY"

BUGSINK = {
    "BASE_URL": "https://%s" % _DOMAIN,

    "SITE_TITLE": os.environ.get("BUGSINK_SITE_TITLE", "Bugsink"),

    "SINGLE_USER": _envbool("BUGSINK_SINGLE_USER", "false"),

    "USER_REGISTRATION": CB_MEMBERS,
    "USER_REGISTRATION_VERIFY_EMAIL": True,
    "USER_REGISTRATION_VERIFY_EMAIL_EXPIRY": 3 * 24 * 60 * 60,

    "SINGLE_TEAM": _envbool("BUGSINK_SINGLE_TEAM", "false"),
    "TEAM_CREATION": CB_MEMBERS,

    "INGEST_STORE_BASE_DIR": os.path.join(BASE_DIR, "ingestion"),

    "MINIMIZE_INFORMATION_EXPOSURE": _envbool("BUGSINK_MINIMIZE_INFO", "false"),
}

ALLOWED_HOSTS = deduce_allowed_hosts(BUGSINK["BASE_URL"])

FORCE_SCRIPT_NAME = deduce_script_name(BUGSINK["BASE_URL"])
if FORCE_SCRIPT_NAME:
    STATIC_URL = f"{FORCE_SCRIPT_NAME}/static/"
