"""Server-address handling without any GUI or network side effects."""

from urllib.parse import unquote, urlsplit, urlunsplit


def normalize_server(value: str) -> str:
    value = value.strip()
    if not value or any(char.isspace() for char in value):
        raise ValueError("Enter the server IP address or hostname, with an optional port.")
    explicit_scheme = "://" in value
    if not explicit_scheme:
        value = "http://" + value
    try:
        parts = urlsplit(value)
        port = parts.port
        host = parts.hostname
    except ValueError as error:
        raise ValueError("Check the address and port. Put IPv6 addresses in brackets.") from error
    if parts.scheme.lower() not in ("http", "https") or not host:
        raise ValueError("Use an HTTP or HTTPS Flyleaf server address.")
    if parts.username is not None or parts.password is not None:
        raise ValueError("Enter only the server address. Sign in on the next screen.")
    if parts.query or parts.fragment or "\\" in value or any(ord(char) < 32 for char in value):
        raise ValueError("Remove query parameters, fragments, and backslashes from the address.")
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("The port must be between 1 and 65535.")
    if not explicit_scheme and port is None:
        port = 7878
    try:
        host = host.encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise ValueError("That hostname is not valid.") from error
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc += f":{port}"
    path = parts.path.rstrip("/")
    # A reverse-proxy path is supported, but never interpret an API URL as the server root.
    if path.endswith("/api") or "/api/" in path:
        raise ValueError("Enter the server's base address, without /api or an API endpoint.")
    if any(segment in (".", "..") for segment in path.split("/")) or "%" in path:
        raise ValueError("Use the server's ordinary base path without encoded path segments.")
    return urlunsplit((parts.scheme.lower(), netloc, path, "", ""))


def server_url(base: str, path: str) -> str:
    """Keep API, cover, and page requests within the selected server and base path."""
    if not isinstance(path, str) or "\\" in path or any(ord(char) < 32 for char in path):
        raise ValueError("The server returned an invalid resource address.")
    try:
        selected, target = urlsplit(base), urlsplit(path)
        selected_port = selected.port or (443 if selected.scheme == "https" else 80)
        target_port = target.port or (443 if target.scheme == "https" else 80)
    except ValueError as error:
        raise ValueError("The server returned an invalid resource address.") from error
    decoded = unquote(unquote(target.path))
    if target.fragment or "\\" in decoded or any(segment in (".", "..") for segment in decoded.split("/")):
        raise ValueError("A resource contains an unsafe path or fragment.")
    if not target.scheme and not target.netloc and target.path.startswith("/api/"):
        return base + path
    prefix = selected.path.rstrip("/") + "/api/"
    if (target.scheme, target.hostname, target_port) != (selected.scheme, selected.hostname, selected_port):
        raise ValueError("A resource points outside the connected Flyleaf server.")
    if target.username is not None or target.password is not None or target.fragment or not target.path.startswith(prefix):
        raise ValueError("A resource points outside the connected Flyleaf API.")
    return path
