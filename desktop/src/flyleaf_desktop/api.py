"""Asynchronous Qt networking. Cookies and passwords never go into application settings."""

import json
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlencode

from PySide6.QtCore import QByteArray, QFile, QIODevice, QObject, QSaveFile, QUrl, Signal, QTimer
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkCookie, QNetworkCookieJar, QNetworkReply, QNetworkRequest

from . import __version__
from .address import normalize_server, server_url

Success = Callable[[Any], None]


@dataclass(frozen=True)
class ApiError:
    message: str
    status: int = 0
    details: dict | None = None


class FlyleafApi(QObject):
    session_expired = Signal()

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self.manager = QNetworkAccessManager(self)
        self.base = ""
        self.offline = False
        self.capabilities = {}
        self.reliability = None
        self._generation = 0
        self._active: set[QNetworkReply] = set()

    def reset(self) -> None:
        self.offline = False
        self._generation += 1
        for reply in list(self._active):
            reply.abort()
        self.manager.setCookieJar(QNetworkCookieJar(self.manager))
        self.manager.clearAccessCache()

    def connect_server(self, address: str) -> None:
        normalized = normalize_server(address)
        self.reset()
        self.base = normalized

    def export_session(self, user_id: int) -> str | None:
        for cookie in self.manager.cookieJar().cookiesForUrl(QUrl(self.base + "/api/status")):
            if bytes(cookie.name()) == b"flyleaf_session":
                return json.dumps({"server": self.base, "userId": user_id,
                                   "cookie": bytes(cookie.toRawForm()).decode("latin-1")})
        return None

    def restore_session(self, value: str) -> int:
        if not isinstance(value, str) or len(value) > 8192:
            raise ValueError("The saved session is invalid. Sign in again.")
        data = json.loads(value)
        if data.get("server") != self.base or type(data.get("userId")) is not int:
            raise ValueError("The saved session does not belong to this server.")
        cookies = QNetworkCookie.parseCookies(data.get("cookie", "").encode("latin-1"))
        if len(cookies) != 1 or bytes(cookies[0].name()) != b"flyleaf_session":
            raise ValueError("The saved session is invalid. Sign in again.")
        cookie = cookies[0]
        if not cookie.isSessionCookie() and cookie.expirationDate().toSecsSinceEpoch() <= time.time():
            raise ValueError("The saved session expired. Sign in again.")
        cookie.setDomain(QUrl(self.base).host())
        cookie.setPath((QUrl(self.base).path().rstrip("/") or "") + "/")
        if not self.manager.cookieJar().setCookiesFromUrl([cookie], QUrl(self.base + "/")):
            raise ValueError("The saved session cannot be used with this server address.")
        return data["userId"]

    def json(self, method: str, path: str, success: Success,
             failure: Callable[[ApiError], None], body: dict | None = None,
             params: dict | None = None, *, durable=True) -> QNetworkReply | None:
        import re
        match = re.fullmatch(r"/api/books/(\d+)/progress", path)
        if durable and method == "PUT" and match and self.reliability and self.reliability.enabled:
            self.reliability.submit(int(match[1]), body or {}, success, failure)
            return None
        if params:
            path += "?" + urlencode({key: value for key, value in params.items() if value is not None and value != ""}, doseq=True)
        payload = json.dumps(body).encode("utf-8") if body is not None else b""
        return self._request(method, path, success, failure, payload, True, 4 * 1024 * 1024)

    def image(self, path: str, success: Success, failure: Callable[[ApiError], None],
              *, page: bool = False) -> QNetworkReply | None:
        return self._request("GET", path, success, failure, b"", False,
                             24 * 1024 * 1024 if page else 4 * 1024 * 1024)

    def binary(self, path, success, failure, maximum=128 * 1024 * 1024):
        return self._request("GET", path, success, failure, b"", False, maximum, "application/octet-stream, */*")

    def upload_file(self, path, source, success, failure, progress=None, *, method="PUT"):
        device = QFile(str(source))
        if not device.open(QIODevice.OpenModeFlag.ReadOnly):
            failure(ApiError(device.errorString()))
            return None
        reply = self._request(method, path, success, failure, device, True, 1024 * 1024,
                              content_type="application/octet-stream", progress=progress)
        if reply:
            device.setParent(reply)
        else:
            device.close()
        return reply

    def download_file(self, path, destination, success, failure, progress):
        return self._request("GET", path, success, failure, b"", False, 1024 * 1024,
                             "*/*", destination=str(destination), progress=progress)

    def _request(self, method: str, path: str, success: Success,
                 failure: Callable[[ApiError], None], payload: bytes | QFile,
                 expect_json: bool, maximum: int, accept=None, *, content_type=None, destination=None,
                 progress=None) -> QNetworkReply | None:
        if self.offline:
            cached = self.reliability.cached(path, expect_json) if method == "GET" and not destination and self.reliability else None
            generation = self._generation
            def deliver_cached():
                if generation == self._generation:
                    success(cached) if cached is not None else failure(ApiError("This item is not available offline. Reconnect to your Flyleaf server."))
            QTimer.singleShot(0, deliver_cached)
            return None
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
        request.setRawHeader(b"Accept", accept.encode("ascii") if accept else b"application/json" if expect_json else b"image/*")
        if payload or content_type:
            request.setHeader(QNetworkRequest.KnownHeaders.ContentTypeHeader, content_type or "application/json")
        if isinstance(payload, QFile):
            request.setHeader(QNetworkRequest.KnownHeaders.ContentLengthHeader, payload.size())
        reply = self.manager.sendCustomRequest(request, method.encode("ascii"), payload if isinstance(payload, QFile) else QByteArray(payload))
        self._active.add(reply)
        generation = self._generation
        buffer = bytearray()
        too_large = False
        tls_failed = False
        output = QSaveFile(destination) if destination else None
        write_error = None

        def response_identity():
            status = int(reply.attribute(QNetworkRequest.Attribute.HttpStatusCodeAttribute) or 0)
            account = bytes(reply.rawHeader("X-Flyleaf-Account")).decode("ascii", errors="replace")
            service = self.reliability
            mismatch = service and service.scope and service.user and account and account != str(service.user["id"])
            return status, account, mismatch

        def consume() -> None:
            nonlocal too_large, write_error
            if generation != self._generation or write_error or too_large:
                return
            chunk = bytes(reply.readAll())
            if output:
                status, account, mismatch = response_identity()
                if 200 <= status < 300:
                    if mismatch or (self.reliability and self.reliability.enabled and not account):
                        return
                    if (not output.isOpen() and not output.open(QIODevice.OpenModeFlag.WriteOnly)) or output.write(chunk) != len(chunk):
                        write_error = output.errorString()
                        reply.abort()
                    return
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
                if output and output.isOpen():
                    output.cancelWriting()
                reply.deleteLater()
                return
            consume()
            status, account, mismatch = response_identity()
            error_code = reply.error()
            error_text = reply.errorString()
            raw = bytes(buffer)
            reply.deleteLater()
            service = self.reliability
            if output and output.isOpen() and (write_error or mismatch or not 200 <= status < 300
                                               or error_code != QNetworkReply.NetworkError.NoError):
                output.cancelWriting()
            if mismatch:
                self.session_expired.emit()
                return
            public = path.split("?", 1)[0] in ("/api/status", "/api/login", "/api/logout", "/api/register", "/api/setup")
            if service and service.enabled and not public and status and status != 401 and not account:
                failure(ApiError("The server response's account identity could not be verified. Update the server or check proxy response headers."))
                return
            if too_large:
                failure(ApiError("The server response exceeded this client's size limit.", status))
                return
            if write_error:
                failure(ApiError("Could not save the download: " + write_error))
                return
            if 300 <= status < 400:
                failure(ApiError("The server redirected this request. Enter its final Flyleaf address, including any HTTPS or proxy base path.", status))
                return
            if not 200 <= status < 300 or error_code != QNetworkReply.NetworkError.NoError:
                message = ""
                problem = None
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
                if self.reliability:
                    if not isinstance(problem, dict) or problem.get("reason") != "accountMismatch":
                        self.reliability.denied(path, status)
                if isinstance(problem, dict) and problem.get("reason") == "accountMismatch":
                    self.session_expired.emit(); return
                failure(ApiError(message or f"The server returned HTTP {status}.", status, problem if isinstance(problem, dict) else None))
                if generation == self._generation and status == 401 and path.split("?", 1)[0] not in ("/api/login", "/api/status", "/api/register", "/api/setup"):
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
                if self.reliability and method == "GET":
                    try:
                        self.reliability.observed(path, data)
                    except (OSError, ValueError) as error:
                        failure(ApiError("The local reading state could not be stored: " + str(error)))
                        return
                success(data)
            elif output:
                if output.isOpen() and output.commit():
                    success(destination)
                else:
                    failure(ApiError("Could not save the download: " + output.errorString()))
            else:
                success(raw)

        reply.readyRead.connect(consume)
        if progress:
            (reply.uploadProgress if isinstance(payload, QFile) else reply.downloadProgress).connect(progress)
        reply.sslErrors.connect(ssl_errors)
        reply.finished.connect(finished)
        return reply
