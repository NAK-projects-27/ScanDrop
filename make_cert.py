#!/usr/bin/env python3
"""
make_cert.py - Create a self-signed HTTPS certificate using ONLY the Python
standard library. No pip, no OpenSSL, no admin rights needed.

Why this exists:
  Phone browsers refuse to give a web page the camera unless the page is on
  https:// (or localhost). Serving ScanDrop over https with this certificate
  makes the camera work on your phone.

Usage:
  python make_cert.py            -> writes cert.pem and key.pem next to this file
  python make_cert.py --force    -> regenerate even if they already exist

Everything stays local. The key never leaves your machine.
"""

import argparse
import hashlib
import ipaddress
import os
import secrets
import socket
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CERT_PATH = os.path.join(HERE, "cert.pem")
KEY_PATH = os.path.join(HERE, "key.pem")

VALID_DAYS = 397  # Apple rejects TLS certs valid for longer than 398 days.


# ------------------------------------------------------------------
# Minimal DER (ASN.1) encoder
# ------------------------------------------------------------------
def _der_len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def _tlv(tag, content):
    return bytes([tag]) + _der_len(len(content)) + content


def d_int(n):
    if n == 0:
        body = b"\x00"
    else:
        body = n.to_bytes((n.bit_length() // 8) + 1, "big")
    return _tlv(0x02, body)


def d_bitstring(data, unused_bits=0):
    return _tlv(0x03, bytes([unused_bits]) + data)


def d_octetstring(data):
    return _tlv(0x04, data)


def d_null():
    return b"\x05\x00"


def d_bool(v):
    return _tlv(0x01, b"\xff" if v else b"\x00")


def d_seq(*items):
    return _tlv(0x30, b"".join(items))


def d_set(*items):
    return _tlv(0x31, b"".join(items))


def d_utf8(text):
    return _tlv(0x0C, text.encode("utf-8"))


def d_utctime(dt):
    return _tlv(0x17, dt.strftime("%y%m%d%H%M%SZ").encode("ascii"))


def d_oid(dotted):
    parts = [int(x) for x in dotted.split(".")]
    body = bytes([parts[0] * 40 + parts[1]])
    for p in parts[2:]:
        chunk = bytearray([p & 0x7F])
        p >>= 7
        while p:
            chunk.insert(0, (p & 0x7F) | 0x80)
            p >>= 7
        body += bytes(chunk)
    return _tlv(0x06, body)


def d_explicit(num, content):
    return _tlv(0xA0 | num, content)


# ------------------------------------------------------------------
# RSA key generation (stdlib only)
# ------------------------------------------------------------------
SMALL_PRIMES = [
    2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67,
    71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149,
    151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199, 211, 223, 227, 229,
    233, 239, 241, 251,
]


def _is_probable_prime(n, rounds=32):
    if n < 2:
        return False
    for p in SMALL_PRIMES:
        if n % p == 0:
            return n == p

    d = n - 1
    r = 0
    while d % 2 == 0:
        d //= 2
        r += 1

    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x == 1 or x == n - 1:
            continue
        for _ in range(r - 1):
            x = x * x % n
            if x == n - 1:
                break
        else:
            return False
    return True


def _gen_prime(bits):
    while True:
        candidate = secrets.randbits(bits) | (3 << (bits - 2)) | 1
        if _is_probable_prime(candidate):
            return candidate


def generate_rsa_key(bits=2048):
    e = 65537
    half = bits // 2
    while True:
        p = _gen_prime(half)
        q = _gen_prime(half)
        if p == q:
            continue
        n = p * q
        if n.bit_length() != bits:
            continue
        phi = (p - 1) * (q - 1)
        if phi % e == 0:
            continue
        d = pow(e, -1, phi)
        return {
            "n": n, "e": e, "d": d, "p": p, "q": q,
            "dp": d % (p - 1),
            "dq": d % (q - 1),
            "qinv": pow(q, -1, p),
        }


def private_key_pem(k):
    der = d_seq(
        d_int(0), d_int(k["n"]), d_int(k["e"]), d_int(k["d"]),
        d_int(k["p"]), d_int(k["q"]), d_int(k["dp"]), d_int(k["dq"]),
        d_int(k["qinv"]),
    )
    return _pem("RSA PRIVATE KEY", der)


def _pem(label, der_bytes):
    import base64
    b64 = base64.b64encode(der_bytes).decode("ascii")
    lines = [b64[i:i + 64] for i in range(0, len(b64), 64)]
    return "-----BEGIN %s-----\n%s\n-----END %s-----\n" % (
        label, "\n".join(lines), label)


# ------------------------------------------------------------------
# Signing (PKCS#1 v1.5 with SHA-256)
# ------------------------------------------------------------------
OID_RSA_ENC = "1.2.840.113549.1.1.1"
OID_SHA256_RSA = "1.2.840.113549.1.1.11"
OID_SHA256 = "2.16.840.1.101.3.4.2.1"
OID_CN = "2.5.4.3"
OID_O = "2.5.4.10"
OID_BASIC_CONSTRAINTS = "2.5.29.19"
OID_KEY_USAGE = "2.5.29.15"
OID_EXT_KEY_USAGE = "2.5.29.37"
OID_SAN = "2.5.29.17"
OID_SUBJECT_KEY_ID = "2.5.29.14"
OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1"


def sign_sha256(key, message):
    digest = hashlib.sha256(message).digest()
    digest_info = d_seq(d_seq(d_oid(OID_SHA256), d_null()), d_octetstring(digest))

    k = (key["n"].bit_length() + 7) // 8
    ps_len = k - len(digest_info) - 3
    em = b"\x00\x01" + (b"\xff" * ps_len) + b"\x00" + digest_info

    sig_int = pow(int.from_bytes(em, "big"), key["d"], key["n"])
    return sig_int.to_bytes(k, "big")


# ------------------------------------------------------------------
# Certificate assembly
# ------------------------------------------------------------------
def _name(common_name, org):
    return d_seq(
        d_set(d_seq(d_oid(OID_O), d_utf8(org))),
        d_set(d_seq(d_oid(OID_CN), d_utf8(common_name))),
    )


def _spki(key):
    rsa_pub = d_seq(d_int(key["n"]), d_int(key["e"]))
    return d_seq(d_seq(d_oid(OID_RSA_ENC), d_null()), d_bitstring(rsa_pub))


def _extension(oid, critical, value_der):
    items = [d_oid(oid)]
    if critical:
        items.append(d_bool(True))
    items.append(d_octetstring(value_der))
    return d_seq(*items)


def _san_extension(dns_names, ip_addresses):
    general_names = []
    for name in dns_names:
        general_names.append(_tlv(0x82, name.encode("ascii")))  # dNSName [2]
    for ip in ip_addresses:
        general_names.append(_tlv(0x87, ipaddress.ip_address(ip).packed))  # iPAddress [7]
    return _extension(OID_SAN, False, d_seq(*general_names))


def build_certificate(key, dns_names, ip_addresses, common_name):
    now = datetime.now(timezone.utc) - timedelta(days=1)
    until = now + timedelta(days=VALID_DAYS)

    pubkey_bits = d_seq(d_int(key["n"]), d_int(key["e"]))
    skid = hashlib.sha1(pubkey_bits).digest()

    extensions = d_seq(
        _extension(OID_BASIC_CONSTRAINTS, True, d_seq(d_bool(True))),
        _extension(OID_KEY_USAGE, True, d_bitstring(b"\x86", 1)),  # digSig, keyEnc, keyCertSign
        _extension(OID_EXT_KEY_USAGE, False, d_seq(d_oid(OID_SERVER_AUTH))),
        _san_extension(dns_names, ip_addresses),
        _extension(OID_SUBJECT_KEY_ID, False, d_octetstring(skid)),
    )

    name = _name(common_name, "ScanDrop Local")
    sig_algo = d_seq(d_oid(OID_SHA256_RSA), d_null())

    tbs = d_seq(
        d_explicit(0, d_int(2)),                 # version v3
        d_int(secrets.randbits(64) | 1),         # serial number
        sig_algo,
        name,                                    # issuer (self-signed)
        d_seq(d_utctime(now), d_utctime(until)),
        name,                                    # subject
        _spki(key),
        d_explicit(3, extensions),
    )

    signature = sign_sha256(key, tbs)
    cert_der = d_seq(tbs, sig_algo, d_bitstring(signature))
    return _pem("CERTIFICATE", cert_der)


# ------------------------------------------------------------------
# Local IP discovery
# ------------------------------------------------------------------
def get_local_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            addr = info[4][0]
            try:
                ip = ipaddress.ip_address(addr)
                if ip.version == 4 and not ip.is_loopback:
                    ips.add(str(ip))
            except ValueError:
                pass
    except Exception:
        pass

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass

    return sorted(ips)


def ensure_cert(force=False, quiet=False):
    """Create cert.pem / key.pem if missing. Returns (cert_path, key_path)."""
    if not force and os.path.isfile(CERT_PATH) and os.path.isfile(KEY_PATH):
        return CERT_PATH, KEY_PATH

    ips = get_local_ips()
    all_ips = sorted(set(ips + ["127.0.0.1"]))
    dns_names = ["localhost", socket.gethostname().lower()]
    dns_names = sorted(set(n for n in dns_names if n))

    if not quiet:
        print("Generating a private HTTPS certificate (takes ~5-30 seconds)...")
        print("  Covers: " + ", ".join(dns_names + all_ips))

    key = generate_rsa_key(2048)
    cert_pem = build_certificate(key, dns_names, all_ips, "ScanDrop Local Server")
    key_pem = private_key_pem(key)

    with open(CERT_PATH, "w", encoding="ascii") as f:
        f.write(cert_pem)
    with open(KEY_PATH, "w", encoding="ascii") as f:
        f.write(key_pem)

    try:
        os.chmod(KEY_PATH, 0o600)
    except Exception:
        pass

    if not quiet:
        print("  Wrote " + CERT_PATH)
        print("  Wrote " + KEY_PATH)
    return CERT_PATH, KEY_PATH


def main():
    parser = argparse.ArgumentParser(description="Create a local self-signed HTTPS certificate")
    parser.add_argument("--force", action="store_true", help="Regenerate even if files exist")
    args = parser.parse_args()

    if args.force:
        for p in (CERT_PATH, KEY_PATH):
            if os.path.isfile(p):
                os.remove(p)

    ensure_cert(force=args.force)

    # Sanity check: make sure Python's own TLS stack accepts what we produced.
    import ssl
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT_PATH, KEY_PATH)
    print("Certificate verified as loadable. You can now run: python server.py")


if __name__ == "__main__":
    sys.exit(main()) 
