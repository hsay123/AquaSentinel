# SETUP — brand-new laptop, from zero to "GEE Connected"

Copy-paste this top to bottom. It assumes macOS/Linux; see
[Windows](#windows) for the two commands that differ.

Estimated time: ~10 minutes, dominated by `pip install`.

---

## TL;DR — the one-paragraph version

```bash
git clone <repo-url>
cd AquaSentinel
python3 -m venv venv && source venv/bin/activate
pip install -r backend/requirements.txt
cp .env.example .env
# ask <repo owner> for the GEE service account key, save it to secrets/gee-key.json
$EDITOR .env                       # fill in the two GEE_* values
cd frontend && npm install && cd ..
./setup.sh                         # verifies the above and prints PASS/FAIL
```

Then run the two servers in separate terminals (from the repo root):

```bash
# terminal 1
source venv/bin/activate && uvicorn backend.main:app --reload --port 8000

# terminal 2
cd frontend && npm run dev
```

Open <http://localhost:5173>. **The header must read `● GEE Connected` before you
demo.** If it doesn't, the chip states the specific reason — click it.

---

## 0. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Python | 3.11+ (3.12/3.13/3.14 all work) | `python3 --version` |
| Node.js | 18+ | `node --version` |
| Git | any | `git --version` |

> Run every command below **from the repository root** (the folder containing
> `backend/` and `frontend/`). Starting uvicorn from inside `backend/` is the
> single most common setup mistake; the app now tolerates it, but the docs
> assume the root.

## 1. Clone

```bash
git clone <repo-url>
cd AquaSentinel
```

## 2. Python environment

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
```

<details>
<summary>Windows</summary>

```powershell
python -m venv venv
venv\Scripts\activate
pip install -r backend\requirements.txt
```
</details>

## 3. Frontend dependencies

```bash
cd frontend
npm install
cd ..
```

## 4. Configuration

```bash
cp .env.example .env
```

Then fill in `.env`. The two values that matter:

```ini
GEE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GEE_SERVICE_ACCOUNT_KEY_PATH=./secrets/gee-key.json
GEE_PROJECT_ID=project-326ab593-31e9-43ed-8cd
```

Relative key paths resolve against the repo root, so `./secrets/gee-key.json`
works no matter which directory you launch from.

Everything else in `.env.example` is optional. In particular
`GROQ_API_KEY` only polishes alert wording; without it you get the template
explanations, which are fully functional.

## 5. Get the GEE service account key

**Ask the repo owner for the service account JSON key.** Do not create your own
personal Earth Engine login as the primary path, and never paste the key into
Slack/Discord/email — hand over the file.

Then:

```bash
mkdir -p secrets
# move the downloaded file here, named exactly as GEE_SERVICE_ACCOUNT_KEY_PATH says
mv ~/Downloads/<project>-<name>-<id>.json secrets/gee-key.json
chmod 600 secrets/gee-key.json
```

The key is gitignored (`secrets/`, `*-key.json`) and must stay that way.

<details>
<summary>Owner only: how the service account is created (once, for the team)</summary>

1. Google Cloud console → your project → **IAM & Admin → Service Accounts**.
2. **Create service account** (e.g. `aquasentinel-gee`).
3. Grant it the **Earth Engine User** role on the project
   (*IAM & Admin → Roles → Add role → Earth Engine User*). It is **not**
   included in the default "Editor" role.
4. Also register the project for Earth Engine: <https://code.earthengine.google.com/register>
   (takes a few minutes to propagate).
5. **Keys → Add key → Create new key → JSON.** Download and distribute that one
   file. Set `GEE_PROJECT_ID` to the project ID shown in the console header.
6. Grant each teammate's Google account the **Earth Engine User** role too, so
   they can use <https://code.earthengine.google.com> for ad-hoc checks.
</details>

## 6. Verify

```bash
./setup.sh
```

It re-checks the venv, dependencies, `.env`, key file and a **live GEE
round-trip**, then prints a `PASS`/`FAIL` summary and exits non-zero on
failure. Windows: `.\setup.ps1`.

You can also just hit the endpoint once the server is up:

```bash
curl -s localhost:8000/health | python3 -m json.tool
```

Healthy output:

```json
{
  "status": "ok",
  "gee_connected": true,
  "gee_status": "ok",
  "gee_message": "Earth Engine reachable via service_account (project project-...)."
}
```

## 7. Run

```bash
# terminal 1 — backend, from the repo root
source venv/bin/activate
uvicorn backend.main:app --reload --port 8000

# terminal 2 — frontend
cd frontend && npm run dev
```

Then build the demo cache once (real Sentinel-2 data, ~5–15 min, needs GEE):

```bash
source venv/bin/activate
python -m backend.scripts.precompute
```

`./start_demo.sh` does the precompute + both servers in one command.

---

## When it says `GEE Offline`

The header chip no longer just says "offline" — it names the failure. Click it
for the full reason and fix, and compare against this table:

| `gee_status` | Meaning | Fix |
|---|---|---|
| `no_credentials` | No credential found anywhere on this machine | Service account not set in `.env`, or the key was never placed. See steps 4–5. |
| `service_account_misconfigured` | `GEE_SERVICE_ACCOUNT_EMAIL` / `..._KEY_PATH` disagree, file missing, or the JSON is not a service account key | Backend log prints the exact mismatch. Usually a truncated download or a relative path pointing at the wrong file. |
| `invalid_credentials` | Credentials found but rejected (revoked/rotated key, expired login) | Request a fresh key from the owner. Re-authenticating does **not** help a revoked service account. |
| `project_denied` | Auth works, but the account has no Earth Engine access to `GEE_PROJECT_ID` | Grant the service account the **Earth Engine User** role on that project, or point `GEE_PROJECT_ID` at a project you can access. |
| `network_unreachable` | Cannot open a connection to `earthengine.googleapis.com` | VPN/firewall/proxy. Not an auth problem — re-authorizing will not fix it. |
| `network_timeout` | Reachable but no response in time | Retry, or allowlist the GEE hosts. |

The same detail is logged at backend startup in a boxed block, so scrolling the
terminal that runs uvicorn is enough to self-diagnose.

---

## Basemap

The map uses **plain OpenStreetMap tiles**, which need no API key, no account and
no domain allowlist.

It previously used CARTO's `light_all` style. CARTO now answers every keyless
request to `basemaps.cartocdn.com` with a 2 KB **"API KEY REQUIRED"** watermark
tile — the same bytes for every zoom/row/column — so the map looked subtly
broken rather than obviously unconfigured. That is why it was swapped instead of
keyed: for a hackathon demo, a provider that cannot fail is worth more than a
prettier one.

If you later swap in a keyed provider, do **not** reintroduce a silent
watermark: make the key a required env var and fail loudly at startup, exactly
the way `backend/gee_client.py` fails loudly for GEE.

---

## About `earthengine authenticate`

It still works as a fallback for solo local development — nothing was removed:

```bash
earthengine authenticate
```

But understand what it does: it writes `~/.config/earthengine/credentials`
(Linux/macOS) or `%APPDATA%\earthengine\credentials` (Windows). That file lives
in your home directory, **outside the repo and outside the venv**. A teammate who
clones the repo and recreates the venv gets the `earthengine-api` *package* and
zero authentication — which is precisely how a second laptop ends up with "GEE
Offline" while the app otherwise looks fine. The service account exists to make
auth a property of the project instead of the person.

---

## Windows

Only these differ:

```powershell
python -m venv venv
venv\Scripts\activate
pip install -r backend\requirements.txt
```

```powershell
.\setup.ps1
```

`GEE_SERVICE_ACCOUNT_KEY_PATH=./secrets/gee-key.json` works unchanged —
`forward slashes` are accepted by Python on Windows.

---

## Troubleshooting

**`ModuleNotFoundError: No module named 'backend'`** — you started uvicorn from
inside `backend/`, or the venv isn't active. Run `uvicorn backend.main:app` from
the repo root with the venv activated.

**Vite proxy errors / frontend can't reach the API** — the backend must be on
port 8000 (override with `VITE_BACKEND_ORIGIN`). The dev server proxies
`/api/*` → `http://localhost:8000/*`, stripping the `/api` prefix.

**`Failed to load waterbodies`** — the backend isn't running or isn't on 8000.
The banner now includes the underlying error instead of a bare string.

**No alerts / empty charts** — run `python -m backend.scripts.precompute`. It
needs working GEE credentials and takes 5–15 minutes for the two demo AOIs.
