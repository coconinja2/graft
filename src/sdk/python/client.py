"""Python SDK for the Graft bus."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional
import httpx
from pydantic import BaseModel


class Claim(BaseModel):
    resourceId: str
    agentId: str
    intent: str
    ttl: int
    claimedAt: int
    expiresAt: int
    lastHeartbeat: int
    claimType: str


class ClaimHolder(BaseModel):
    agentId: str
    intent: str
    claimedAt: int
    ttl: int


class ClaimResult(BaseModel):
    granted: bool
    claim: Optional[Claim] = None
    holder: Optional[ClaimHolder] = None
    conflictId: Optional[str] = None


class ChangeSummaryPayload(BaseModel):
    what: str
    why: str
    breakingChange: bool
    affectedResources: list[str]
    diff: Optional[str] = None


class Signal(BaseModel):
    signalId: str
    type: str
    from_: str = field(alias="from")
    message: str
    affectedResources: Optional[list[str]] = None
    severity: Optional[str] = None
    changeContext: Optional[ChangeSummaryPayload] = None
    ts: int

    class Config:
        populate_by_name = True


class SignalHistoryEntry(Signal):
    deliveredTo: Optional[str] = None
    deliveredAt: Optional[int] = None
    status: str


class AuditEntry(BaseModel):
    seq: int
    ts: int
    type: str
    agentId: str
    resourceId: Optional[str] = None
    signalId: Optional[str] = None
    conflictId: Optional[str] = None
    deadlockId: Optional[str] = None
    detail: dict[str, Any] = {}


class ConflictEntry(BaseModel):
    conflictId: str
    resourceId: str
    requestingAgent: dict[str, Any]
    holdingAgent: dict[str, Any]
    ts: int
    resolution: str
    resolvedAt: Optional[int] = None


class DeadlockEntry(BaseModel):
    deadlockId: str
    ts: int
    cycle: list[dict[str, str]]
    resolution: str
    resolvedAt: Optional[int] = None


class PoolStatus(BaseModel):
    total: int
    available: int
    inUse: int
    waiters: int


class WaveStatus(BaseModel):
    name: str
    agents: list[str]
    completed: list[str]
    pending: list[str]
    done: bool


class GraftClient:
    def __init__(self, bus_url: str = "http://localhost:7433", agent_id: str = ""):
        self.bus_url = bus_url.rstrip("/")
        self.agent_id = agent_id
        self._client = httpx.Client(base_url=self.bus_url, timeout=30.0)

    def _request(self, method: str, path: str, timeout: Optional[float] = None, **kwargs: Any) -> Any:
        resp = self._client.request(method, path, timeout=timeout or self._client.timeout, **kwargs)
        resp.raise_for_status()
        return resp.json()

    # ── Claims ──────────────────────────────────────────────────────────────

    def claim(self, resource_id: str, intent: str, ttl: int = 120, claim_type: str = "write") -> ClaimResult:
        data = self._request("POST", "/claims", json={
            "resource_id": resource_id,
            "agent_id": self.agent_id,
            "intent": intent,
            "ttl": ttl,
            "claim_type": claim_type,
        })
        return ClaimResult(**data)

    def release(self, resource_id: str) -> bool:
        data = self._request(
            "DELETE",
            f"/claims/{resource_id}",
            params={"agent_id": self.agent_id},
        )
        return data.get("released", False)

    def heartbeat(self, resource_id: str) -> bool:
        try:
            self._request("POST", f"/claims/{resource_id}/heartbeat", json={"agent_id": self.agent_id})
            return True
        except httpx.HTTPError:
            return False

    def force_release_agent(self, agent_id: str) -> dict[str, Any]:
        """Force-release all claims held by agent_id (e.g. after detecting a crash)."""
        return self._request("DELETE", f"/agents/{agent_id}/claims")

    def wait_for_release(self, resource_id: str, timeout_ms: int = 30_000) -> None:
        """Blocks until resource_id is released or timeout_ms elapses."""
        self._request(
            "GET",
            f"/claims/{resource_id}/wait",
            params={"timeout_ms": timeout_ms},
            timeout=timeout_ms / 1000 + 5,
        )

    def list_claims(self) -> list[Claim]:
        return [Claim(**c) for c in self._request("GET", "/claims")]

    def get_claim(self, resource_id: str) -> Optional[Claim]:
        data = self._request("GET", f"/claims/{resource_id}")
        return Claim(**data) if data else None

    # ── Signals ─────────────────────────────────────────────────────────────

    def subscribe(self, types: list[str]) -> None:
        self._request("POST", "/signals/subscribe", json={"agent_id": self.agent_id, "types": types})

    def publish(
        self,
        type: str,
        message: str,
        affected_resources: Optional[list[str]] = None,
        severity: Optional[str] = None,
        change_context: Optional[ChangeSummaryPayload] = None,
    ) -> Signal:
        data = self._request("POST", "/signals", json={
            "type": type,
            "from": self.agent_id,
            "message": message,
            "affected_resources": affected_resources,
            "severity": severity,
            "change_context": change_context.model_dump() if change_context else None,
        })
        return Signal(**data)

    def get_pending_signals(self) -> list[Signal]:
        data = self._request("GET", "/signals/pending", params={"agent_id": self.agent_id})
        return [Signal(**s) for s in data]

    def get_signal_history(self, from_agent: Optional[str] = None, type: Optional[str] = None) -> list[SignalHistoryEntry]:
        params: dict[str, str] = {"agent": self.agent_id}
        if from_agent:
            params["from"] = from_agent
        if type:
            params["type"] = type
        data = self._request("GET", "/signals/history", params=params)
        return [SignalHistoryEntry(**s) for s in data]

    # ── Pool ─────────────────────────────────────────────────────────────────

    def acquire_pool(self, pool_name: str, timeout_ms: int = 30_000) -> str:
        data = self._request("POST", f"/pool/{pool_name}/acquire", json={
            "agent_id": self.agent_id,
            "timeout_ms": timeout_ms,
        })
        return data["resource"]

    def release_pool(self, pool_name: str, resource: str) -> bool:
        data = self._request("DELETE", f"/pool/{pool_name}/release", json={
            "agent_id": self.agent_id,
            "resource": resource,
        })
        return data.get("released", False)

    def pool_status(self, pool_name: str) -> PoolStatus:
        return PoolStatus(**self._request("GET", f"/pool/{pool_name}/status"))

    # ── Wave ─────────────────────────────────────────────────────────────────

    def wave_register(self, name: str, agents: Optional[list[str]] = None) -> None:
        self._request("POST", "/wave/register", json={"name": name, "agent_id": self.agent_id, "agents": agents})

    def wave_complete(self, name: str) -> WaveStatus:
        return WaveStatus(**self._request("POST", "/wave/complete", json={"name": name, "agent_id": self.agent_id}))

    def wave_status(self, name: str) -> WaveStatus:
        return WaveStatus(**self._request("GET", f"/wave/{name}"))

    # ── Audit & Debugging ────────────────────────────────────────────────────

    def get_audit_log(
        self,
        agent_id: Optional[str] = None,
        resource_id: Optional[str] = None,
        type: Optional[str] = None,
        since: Optional[int] = None,
        limit: int = 200,
    ) -> list[AuditEntry]:
        params: dict[str, Any] = {"limit": limit}
        if agent_id:
            params["agent"] = agent_id
        if resource_id:
            params["resource"] = resource_id
        if type:
            params["type"] = type
        if since is not None:
            params["since"] = since
        return [AuditEntry(**e) for e in self._request("GET", "/audit", params=params)]

    def get_conflicts(self, agent_id: Optional[str] = None, resource_id: Optional[str] = None) -> list[ConflictEntry]:
        params: dict[str, str] = {}
        if agent_id:
            params["agent"] = agent_id
        if resource_id:
            params["resource"] = resource_id
        return [ConflictEntry(**c) for c in self._request("GET", "/conflicts", params=params)]

    def get_deadlocks(self) -> list[DeadlockEntry]:
        return [DeadlockEntry(**d) for d in self._request("GET", "/deadlocks")]

    def get_timeline(self, agent_id: Optional[str] = None, since: Optional[int] = None) -> list[AuditEntry]:
        target = agent_id or self.agent_id
        params: dict[str, Any] = {}
        if since is not None:
            params["since"] = since
        return [AuditEntry(**e) for e in self._request("GET", f"/timeline/{target}", params=params)]

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health")

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "GraftClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()
