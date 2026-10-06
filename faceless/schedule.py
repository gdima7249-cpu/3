"""Раздача слотов публикации по расписанию (publish_times в локальной зоне канала)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo


def next_slots(count: int, *, publish_times: list[str], tz: str, taken: set[str],
               now: datetime | None = None, min_lead: timedelta = timedelta(minutes=30)) -> list[str]:
    """Возвращает `count` ближайших свободных слотов в UTC ISO-8601."""
    zone = ZoneInfo(tz)
    now = (now or datetime.now(timezone.utc)).astimezone(zone)
    times = sorted(tuple(map(int, t.split(":"))) for t in publish_times)
    out: list[str] = []
    day = now.date()
    while len(out) < count:
        for hh, mm in times:
            local = datetime(day.year, day.month, day.day, hh, mm, tzinfo=zone)
            if local < now + min_lead:
                continue
            iso = local.astimezone(timezone.utc).isoformat(timespec="seconds")
            if iso not in taken and iso not in out:
                out.append(iso)
                if len(out) == count:
                    break
        day += timedelta(days=1)
    return out
