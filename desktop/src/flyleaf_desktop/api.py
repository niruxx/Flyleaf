"""Asynchronous Qt networking. Cookies and passwords never go into application settings."""

import json
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlencode

from PySide6.QtCore import QByteArray, QObject, QUrl, Signal
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkCookieJar, QNetworkReply, QNetworkRequest

from . import __version__
from .address import normalize_server, server_url

Success = Callable[[Any], None]


@dataclass(frozen=True)
class ApiError:
    message: str
    status: int = 0


class FlyleafApi(QObject):
    session_expired = Signal()

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self.manager = QNetworkAccessManager(self)
        self.base = ""
        self._generation = 0
        self._active: set[QNetworkReply] = set()

    def reset(self) -> None:
        self._generation += 1
        for reply in list(self._active):
            reply.abort()
        self.manager.setCookieJar(QNetworkCookieJar(self.manager))
        self.manager.clearAccessCache()

    def connect_server(self, address: str) -> None:
        normalized = normalize_server(address)
        self.reset()
        self.base = normalized

    def json(self, method: str, path: str, success: Success,
             failure: Callable[[ApiError], None], body: dict | None = None,
             params: dict | None = None) -> QNetworkReply | None:
        if params:
            path += "?" + urlencode({key: value for key, value in params.items() if value is not None and value != ""})
        payload = json.dumps(body).encode("utf-8") if body is not None else b""
        return self._request(method, path, success, failure, payload, True, 4 * 1024 * 1024)

    def image(self, path: str, success: Success, failure: Callable[[ApiError], None],
              *, page: bool = False) -> QNetworkReply | None:
        return self._request("GET", path, success, failure, b"", False,
                             24 * 1024 * 1024 if page else 4 * 1024 * 1024)

    def _request(self, method: str, path: str, success: Success,
                 failure: Callable[[ApiError], None], payload: bytes,
                 expect_json: bool, maximum: int) -> QNetworkReply | None:
        if not self.base:
            failure(ApiError("Connect to a server first."))
            return None
        try:
            url = server_url(self.base, path)
        except ValueError as error:
            failure(ApiError(str(error)))
            return None
        request = QNetworkRequest(QUrl(url))
        request.setTransferTimeout(20_000)
        request.setAttribute(QNetworkRequest.Attribute.RedirectPolicyAttribute,
                             QNetworkRequest.RedirectPolicy.ManualRedirectPolicy)
        request.setRawHeader(b"X-Flyleaf", b"1")
        request.setRawHeader(b"User-Agent", f"FlyleafDesktop/{__version__}".encode("ascii"))
        request.setRawHeader(b"Accept", b"application/json" if expect_json else b"image/*")
        if payload:
            request.setHeader(QNetworkRequest.KnownHeaders.ContentTypeHeader, "application/json")
        reply = self.manager.sendCustomRequest(request, method.encode("ascii"), QByteArray(payload))
        self._active.add(reply)
        generation = self._generation
        buffer = bytearray()
        too_large = False
        tls_failed = False

        def consume() -> None:
            nonlocal too_large
            chunk = bytes(reply.readAll())
            if len(buffer) + len(chunk) > maximum:
                too_large = True
                reply.abort()
            else:
                buffer.extend(chunk)

        def ssl_errors(_errors: list) -> None:
            nonlocal tls_failed
            tls_failed = True  # Certificate errors are never ignored.

        def finished() -> None:
            self._active.discard(reply)
            if generation != self._generation:
                reply.deleteLater()
                return
            consume()
            status = int(reply.attribute(QNetworkRequest.Attribute.HttpStatusCodeAttribute) or 0)
            error_code = reply.error()
            error_text = reply.errorString()
            raw = bytes(buffer)
            reply.deleteLater()
            if too_large:
                failure(ApiError("The server response exceeded this client's size limit.", status))
                return
            if 300 <= status < 400:
                failure(ApiError("The server redirected this request. Enter its final Flyleaf address, including any HTTPS or proxy base path.", status))
                return
            if not 200 <= status < 300 or error_code != QNetworkReply.NetworkError.NoError:
                message = ""
                try:
                    problem = json.loads(raw)
                    if isinstance(problem, dict) and isinstance(problem.get("error"), str):
                        message = problem["error"][:500]
                except (ValueError, UnicodeError):
                    pass
                if tls_failed:
                    message = "TLS certificate validation failed. Check the server hostname, certificate chain, and system clock."
                elif status == 429:
                    message = message or "Too many sign-in attempts or requests. Wait before retrying."
                elif status == 401:
                    message = message or "Your session expired. Sign in again."
                elif not status:
                    message = f"Cannot reach the server. Check the address, port, firewall, and connection. ({error_text})"
                failure(ApiError(message or f"The server returned HTTP {status}.", status))
                if status == 401 and path != "/api/login":
                    self.session_expired.emit()
                return
            if expect_json:
                try:
                    data = json.loads(raw)
                    if not isinstance(data, (dict, list)):
                        raise ValueError("Expected a Flyleaf API response")
                except (ValueError, UnicodeError):
                    failure(ApiError("This address did not return a valid Flyleaf API response.", status))
                    return
                success(data)
            else:
                success(raw)

        reply.readyRead.connect(consume)
        reply.sslErrors.connect(ssl_errors)
        reply.finished.connect(finished)
        return reply
