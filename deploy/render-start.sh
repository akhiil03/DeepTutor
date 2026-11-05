#!/bin/bash
set -e

# Render sets PORT (default 10000) and routes public traffic to it. DeepTutor's
# entrypoint reads ports from data/user/settings/system.json and ignores process
# env, so persist Render's port before starting.
: "${PORT:=10000}"

# Render's free filesystem is ephemeral: sessions, practice, settings and KBs
# are lost on redeploy/restart/spin-down. Restore the last snapshot from
# Supabase Storage before the app opens its databases.
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
    python /app/render_data_sync.py restore || \
        echo "WARN: snapshot restore failed; starting from local data"
fi

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

# A cold instance (first boot, or a snapshot without a catalog) has no LLM
# profile. Rebuild it from the service environment so chat keeps working
# without re-entering the key in the UI.
python - <<'PY'
import json, os
from pathlib import Path

key = os.environ.get("NVIDIA_API_KEY", "").strip()
if key:
    path = Path("/app/data/user/settings/model_catalog.json")
    try:
        catalog = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        catalog = {}
    if not isinstance(catalog, dict):
        catalog = {}
    services = catalog.get("services")
    if not isinstance(services, dict):
        services = {}
        catalog["services"] = services
    llm = services.get("llm")
    if not isinstance(llm, dict) or not llm.get("profiles"):
        model = os.environ.get(
            "DEEPTUTOR_LLM_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b"
        ).strip()
        base_url = os.environ.get(
            "DEEPTUTOR_LLM_BASE_URL", "https://integrate.api.nvidia.com/v1"
        ).strip()
        profile_id = "llm-profile-render"
        model_id = "llm-model-render"
        services["llm"] = {
            "active_profile_id": profile_id,
            "active_model_id": model_id,
            "profiles": [
                {
                    "id": profile_id,
                    "name": "Render NVIDIA NIM",
                    "binding": "nvidia_nim",
                    "base_url": base_url,
                    "api_key": key,
                    "api_version": "",
                    "extra_headers": {},
                    "models": [{"id": model_id, "name": model, "model": model}],
                    "api_format": "auto",
                    "wire_api": "auto",
                }
            ],
        }
        for name in ("task", "embedding", "tts", "stt", "imagegen", "videogen"):
            services.setdefault(
                name,
                {"active_profile_id": None, "active_model_id": None, "profiles": []},
            )
        services.setdefault("search", {"active_profile_id": None, "profiles": []})
        catalog["version"] = catalog.get("version", 1)
        catalog.setdefault("connections", [])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
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

# Snapshot uploads run under supervisord so they share the container lifecycle
# and stop before Render kills the instance.
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
    cat >> /etc/supervisor/conf.d/programs.conf <<'EOF'

[program:data-sync]
command=/usr/local/bin/python /app/render_data_sync.py sync-loop
directory=/app
user=deeptutor
autostart=true
autorestart=unexpected
startsecs=5
stopwaitsecs=120
stopsignal=TERM
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0
environment=PYTHONPATH="/app",PYTHONUNBUFFERED="1",HOME="/home/deeptutor"
EOF
fi

exec /app/entrypoint.sh
