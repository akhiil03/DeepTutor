#!/bin/bash
set -e

# Render sets PORT (default 10000) and routes public traffic to it. DeepTutor's
# entrypoint reads ports from data/user/settings/system.json and ignores process
# env, so persist Render's port before starting.
: "${PORT:=10000}"

python - <<'PY'
import json, os
from pathlib import Path

settings = Path("/app/data/user/settings/system.json")
settings.parent.mkdir(parents=True, exist_ok=True)
try:
    data = json.loads(settings.read_text(encoding="utf-8"))
except Exception:
    data = {}
data["backend_port"] = int(os.environ.get("PORT", "10000"))
data["frontend_port"] = 3782
settings.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

# The Vercel deployment owns the UI. Removing the Next.js program keeps the
# API-focused instance from spending its memory on an unused server and avoids
# a second listener competing for Render's port.
python - <<'PY'
from pathlib import Path

conf = Path("/etc/supervisor/conf.d/programs.conf")
text = conf.read_text(encoding="utf-8")
text = text.split("[program:frontend]", 1)[0].rstrip() + "\n"
conf.write_text(text, encoding="utf-8")
PY

exec /app/entrypoint.sh
