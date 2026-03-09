# albedo-pn-maubot: A Maubot Albedo Participating Node implementation
# Copyright (C) 2026 Logan Devine <logan@zirco.dev>
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import time
from typing import Type, Set

from mautrix.types import EventType, RoomID, UserID, StateEvent, Event
from mautrix.util.config import BaseProxyConfig, ConfigUpdateHelper
from maubot import Plugin
from maubot.handlers import event

ALBEDO_ROSTER = EventType.find("dev.zirco.albedo.roster", t_class=EventType.Class.STATE)
ALBEDO_REGISTER = EventType.find("dev.zirco.albedo.register", t_class=EventType.Class.MESSAGE)
ALBEDO_REGISTER_REJECT = EventType.find("dev.zirco.albedo.register.reject", t_class=EventType.Class.MESSAGE)
ALBEDO_LEAVE = EventType.find("dev.zirco.albedo.leave", t_class=EventType.Class.MESSAGE)
ALBEDO_ROUND_START = EventType.find("dev.zirco.albedo.round.start", t_class=EventType.Class.MESSAGE)
ALBEDO_PING = EventType.find("dev.zirco.albedo.ping", t_class=EventType.Class.MESSAGE)
ALBEDO_PONG = EventType.find("dev.zirco.albedo.pong", t_class=EventType.Class.MESSAGE)

USER_AGENT = "albedo-pn-maubot/1.0.0"
STALE_THRESHOLD_MS = 60_000


class Config(BaseProxyConfig):
    def do_update(self, helper: ConfigUpdateHelper) -> None:
        helper.copy("room_id")
        helper.copy("contact_mxid")
        helper.copy("location")


class AlbedoPn(Plugin):
    roster: Set[str]

    async def start(self) -> None:
        self.config.load_and_update()
        self.roster = set()

        room_id = self.room_id
        try:
            await self.client.join_room(room_id)
            self.log.info(f"Joined room {room_id}.")
        except Exception as e:
            self.log.debug(f"Could not join room (may already be a member): {e}")

        await self.update_roster()

        if self.server_name not in self.roster:
            await self.register()

    async def stop(self) -> None:
        await self.leave()

    @classmethod
    def get_config_class(cls) -> Type[BaseProxyConfig]:
        return Config

    @property
    def room_id(self) -> RoomID:
        return RoomID(self.config["room_id"])

    @property
    def server_name(self) -> str:
        return str(self.client.mxid).split(":", 1)[1]

    def sender_server(self, sender: UserID) -> str:
        return str(sender).split(":", 1)[1]

    def is_participant(self, server: str) -> bool:
        return server in self.roster

    def is_stale(self, evt: Event) -> bool:
        age_ms = evt.unsigned.get("age") if evt.unsigned else None
        if age_ms is None:
            return False
        return age_ms > STALE_THRESHOLD_MS

    async def update_roster(self) -> None:
        try:
            content = await self.client.get_state_event(self.room_id, ALBEDO_ROSTER)
            participants = content.get("participants", [])
            self.roster = set(participants)
            self.log.info(f"Loaded roster with {len(self.roster)} participant(s).")
        except Exception as e:
            self.log.warning(f"Could not load roster state event: {e}. Assuming empty roster.")
            self.roster = set()

    async def register(self) -> None:
        await self.client.send_message_event(
            self.room_id,
            ALBEDO_REGISTER,
            {
                "capabilities": [],
                "user_agent": USER_AGENT,
                "contact_mxid": self.config["contact_mxid"],
                "location": self.config["location"],
            },
        )
        self.log.info("Sent registration request to CS.")

    async def leave(self) -> None:
        try:
            await self.client.send_message_event(self.room_id, ALBEDO_LEAVE, {})
            self.log.info("Sent leave event to CS.")
        except Exception as e:
            self.log.error(f"Failed to send leave event: {e}")

    async def send_ping(self, round_id: str) -> None:
        await self.client.send_message_event(
            self.room_id, ALBEDO_PING, {"id": round_id}
        )
        self.log.info(f"Sent ping for round {round_id}.")

    async def send_pong(self, round_id: str, ping_server: str, ms: int) -> None:
        await self.client.send_message_event(
            self.room_id,
            ALBEDO_PONG,
            {"id": round_id, "ping_server": ping_server, "ms": ms},
        )
        self.log.info(f"Sent pong to {ping_server} with latency {ms}ms.")

    @event.on(ALBEDO_ROSTER)
    async def on_roster_update(self, evt: StateEvent) -> None:
        if evt.room_id != self.room_id:
            return

        participants = evt.content.get("participants", [])
        self.roster = set(participants)
        self.log.info(f"Roster updated: {self.roster}")

        if self.server_name not in self.roster:
            self.log.warning("We were removed from the roster. Re-registering with CS...")
            await self.register()

    @event.on(ALBEDO_REGISTER_REJECT)
    async def on_register_reject(self, evt: Event) -> None:
        if evt.room_id != self.room_id:
            return
        if evt.content.get("user") == str(self.client.mxid):
            self.log.warning(
                f"Registration rejected by CS. Code: {evt.content.get('code')}, "
                f"Reason: {evt.content.get('reason')}"
            )

    @event.on(ALBEDO_PING)
    async def on_ping(self, evt: Event) -> None:
        if evt.room_id != self.room_id:
            return
        if self.is_stale(evt):
            return

        sender_server = self.sender_server(evt.sender)

        if not self.is_participant(sender_server):
            self.log.warning(f"Ping from non-participant {sender_server}, ignoring.")
            return

        if sender_server == self.server_name:
            return  # Don't pong our own pings.

        round_id = evt.content.get("id")
        latency = evt.unsigned.get("age") if evt.unsigned else 0
        self.log.info(f"Ping from {sender_server} (id={round_id}), latency={latency}ms.")
        await self.send_pong(round_id, sender_server, latency)

    @event.on(ALBEDO_ROUND_START)
    async def on_round_start(self, evt: Event) -> None:
        if evt.room_id != self.room_id:
            return
        if self.is_stale(evt):
            return
        if evt.content.get("server") != self.server_name:
            return

        round_id = evt.content.get("id")
        self.log.info(f"Round start received (id={round_id}), sending ping.")
        await self.send_ping(round_id)
