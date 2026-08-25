"""Ed25519 identity and Technocore canonical signing."""

from __future__ import annotations

import base64
import os
import re
import stat
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
MULTICODEC_ED25519 = b"\xed\x01"
ROOM_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,47}")
INVISIBLE_CATEGORIES = ("Cc", "Cf", "Cs", "Co", "Zl", "Zp")


def clean_message(text: str) -> str:
    cleaned = "".join(
        " " if unicodedata.category(char) in INVISIBLE_CATEGORIES else char for char in str(text)
    ).strip()
    if not cleaned:
        raise ValueError("message is empty after the Technocore single-line sweep")
    if len(cleaned) > 4096:
        raise ValueError("message exceeds Technocore's 4096-character limit")
    return cleaned


def _base58(raw: bytes) -> str:
    number = int.from_bytes(raw, "big")
    result = ""
    while number:
        number, remainder = divmod(number, 58)
        result = B58[remainder] + result
    for byte in raw:
        if byte:
            break
        result = "1" + result
    return result or "1"


@dataclass(frozen=True, slots=True)
class HostIdentity:
    key: Ed25519PrivateKey
    did: str

    @classmethod
    def from_seed_hex(cls, seed_hex: str) -> HostIdentity:
        normalized = seed_hex.strip().lower()
        if not re.fullmatch(r"[0-9a-f]{64}", normalized):
            raise ValueError("Host seed must be exactly 64 hexadecimal characters")
        key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(normalized))
        public = key.public_key().public_bytes_raw()
        did = "did:key:z" + _base58(MULTICODEC_ED25519 + public)
        return cls(key=key, did=did)

    @classmethod
    def from_file(cls, path: Path) -> HostIdentity:
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise ValueError(f"HOST_SEED_FILE must be a regular file, not a link: {path}")
            if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
                raise ValueError(f"HOST_SEED_FILE must have mode 0600: {path}")
            seed = path.read_text(encoding="ascii")
        except OSError as exc:
            raise ValueError(f"Cannot read HOST_SEED_FILE {path}: {exc}") from exc
        return cls.from_seed_hex(seed)

    def signed_message(self, room: str, nonce: int, text: str) -> dict[str, str]:
        if not ROOM_RE.fullmatch(room):
            raise ValueError("invalid Technocore room")
        nonce_text = str(nonce)
        if not re.fullmatch(r"[0-9]{1,19}", nonce_text):
            raise ValueError("nonce must be 1-19 ASCII digits")
        cleaned = clean_message(text)
        signature = self.key.sign(f"{room}|{nonce_text}|{cleaned}".encode())
        return {
            "did": self.did,
            "sig": base64.urlsafe_b64encode(signature).decode().rstrip("="),
            "nonce": nonce_text,
            "text": cleaned,
        }
