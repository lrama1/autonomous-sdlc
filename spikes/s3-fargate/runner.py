# Spike 3: runs inside the Fargate "runner" container and reports what the sandbox can and cannot do.
import json, os, socket, struct, sys, urllib.request, urllib.error

results = {}

def check(name, fn):
    try:
        results[name] = fn()
    except Exception as e:  # noqa: BLE001
        results[name] = f"EXC {type(e).__name__}: {e}"

def pg():
    s = socket.create_connection(("127.0.0.1", 5432), timeout=5)
    s.sendall(struct.pack("!II", 8, 80877103))  # SSLRequest
    r = s.recv(1)
    s.close()
    return f"sidecar answered on localhost:5432 -> {r!r}"

def sock():
    return f"docker.sock present={os.path.exists('/var/run/docker.sock')}"

def caps():
    eff = next(l for l in open("/proc/self/status") if l.startswith("CapEff")).split()[1]
    v = int(eff, 16)
    return f"CapEff={eff} NET_ADMIN={bool(v & (1 << 12))} NET_RAW={bool(v & (1 << 13))} SYS_ADMIN={bool(v & (1 << 21))}"

def creds():
    return (f"task-role credential URI present={'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI' in os.environ}; "
            f"metadata v4 present={'ECS_CONTAINER_METADATA_URI_V4' in os.environ}")

def fetch(url, proxy=None, timeout=10):
    handler = urllib.request.ProxyHandler({"https": proxy, "http": proxy} if proxy else {})
    op = urllib.request.build_opener(handler)
    try:
        with op.open(url, timeout=timeout) as r:
            return f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        return f"FAIL {type(e).__name__}: {str(e)[:90]}"

proxy = os.environ.get("PROXY_URL")
check("1 sidecar on localhost", pg)
check("2 docker socket", sock)
check("3 capabilities", caps)
check("4 aws credentials in container", creds)
check("5 proxy ALLOWED host (openrouter.ai)", lambda: fetch("https://openrouter.ai/api/v1/models", proxy))
check("6 proxy DENIED host (example.com)", lambda: fetch("https://example.com", proxy))
check("7 DIRECT egress, ignoring proxy (example.com)", lambda: fetch("https://example.com", None, 8))
check("8 DIRECT to other S3 bucket via gateway endpoint", lambda: fetch("https://aws-codedeploy-us-east-1.s3.us-east-1.amazonaws.com/latest/codedeploy-agent.noarch.rpm", None, 8))
check("9 DNS resolves arbitrary external name", lambda: socket.gethostbyname("example.com"))
check("10 DNS resolves attacker-style name", lambda: str(socket.gethostbyname("abc123.exfil.example.net")))

print("SPIKE3_RESULTS " + json.dumps(results, indent=1))
sys.exit(0)
