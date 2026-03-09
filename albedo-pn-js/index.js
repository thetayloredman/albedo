// albedo-pn-js: A reference Albedo Participating Node implementation in JavaScript
// Copyright (C) 2026 Logan Devine <logan@zirco.dev>
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import "dotenv/config";
import mx from "matrix-js-sdk";

const HOMESERVER_URL = process.env.HOMESERVER_URL;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const USER_ID = process.env.USER_ID;
const ROOM_ID = process.env.ROOM_ID;
const CONTACT_MXID = process.env.CONTACT_MXID || null;
const LOCATION = process.env.LOCATION || null;
const SERVER_NAME = USER_ID.split(":").slice(1).join(":");
const USER_AGENT = "albedo-pn-js/1.0.0";

if (!HOMESERVER_URL || !ACCESS_TOKEN || !USER_ID || !ROOM_ID) {
    console.error(
        "Missing required environment variables. Please set HOMESERVER_URL, ACCESS_TOKEN, USER_ID, and ROOM_ID.",
    );
    process.exit(1);
}

const client = mx.createClient({
    baseUrl: HOMESERVER_URL,
    accessToken: ACCESS_TOKEN,
    userId: USER_ID,
});

console.log("Starting Albedo Participating Node...");

client.startClient();

client.once(mx.ClientEvent.Sync, (state) => {
    if (state === "PREPARED") {
        console.log("Client synced and ready.");

        if (!client.getRoom(ROOM_ID)) {
            console.log(
                `Not currently in room ${ROOM_ID}, attempting to join...`,
            );
            client
                .joinRoom(ROOM_ID)
                .then(() => {
                    console.log(`Successfully joined room ${ROOM_ID}.`);
                })
                .catch((err) => {
                    console.error(`Failed to join room ${ROOM_ID}:`, err);
                });
        }

        if (client.getRoom(ROOM_ID)) {
            register();
        }
    }
});
client.on(mx.RoomEvent.MyMembership, (room, membership, prevMembership) => {
    if (membership === mx.KnownMembership.Invite && room.roomId === ROOM_ID) {
        console.log(`Invited to room ${ROOM_ID}, attempting to join...`);
        client
            .joinRoom(ROOM_ID)
            .then(() => {
                console.log(`Successfully joined room ${ROOM_ID}.`);
                register();
            })
            .catch((err) => {
                console.error(`Failed to join room ${ROOM_ID}:`, err);
            });
    }
});

// The most recent roster state event in the room.
let roster = new Set();

async function updateRoster() {
    // Find the roster state event in the room.
    const room = client.getRoom(ROOM_ID);
    if (!room) {
        console.error(`Not in room ${ROOM_ID}, cannot update roster.`);
        return;
    }
    const rosterEvent = room.currentState.getStateEvents(
        "dev.zirco.albedo.roster",
        "",
    );
    if (!rosterEvent) {
        console.warn("No roster event found in room, assuming empty roster.");
        roster = new Set();
        return;
    }
    const rosterContent = rosterEvent.getContent();
    if (!rosterContent || !rosterContent.participants) {
        console.warn(
            "Roster event has no participants field, assuming empty roster.",
        );
        roster = new Set();
        return;
    }
    roster = new Set(rosterContent.participants);
    console.log("Updated roster.");
}

client.on(mx.RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
    if (toStartOfTimeline) return; // Ignore old events when syncing.
    if (event.getAge() > 60000) return; // Ignore events older than 60 seconds because they may be stale.
    if (room.roomId !== ROOM_ID) return; // Ignore events from other rooms.
    if (event.getType() === "dev.zirco.albedo.roster") {
        console.log("Roster state event updated, refreshing roster...");
        updateRoster();

        // If we've been removed from the roster, register again to rejoin.
        const participants = event.getContent().participants || [];
        if (!participants.includes(SERVER_NAME)) {
            console.warn(
                "Removed from roster, attempting to re-register with CS...",
            );
            register();
        }
    }
});

const isParticipant = (server) => roster.has(server);
const eventSender = (event) => event.getSender().split(":").slice(1).join(":");

// Event senders
async function register() {
    if (!client.getRoom(ROOM_ID)) {
        console.error(
            `Cannot register with CS because not currently in room ${ROOM_ID}.`,
        );
        return;
    }
    await client.sendEvent(
        ROOM_ID,
        "dev.zirco.albedo.register",
        {
            capabilities: [],
            user_agent: USER_AGENT,
            contact_mxid: CONTACT_MXID,
            location: LOCATION,
        },
        "",
    );
    console.log("Attempted registration with CS.");
}
async function leave() {
    await client.sendEvent(ROOM_ID, "dev.zirco.albedo.leave", {}, "");
    console.log("Sent leave event to room.");
}
async function sendPing(id) {
    await client.sendEvent(ROOM_ID, "dev.zirco.albedo.ping", { id }, "");
    console.log("Sent ping event to room.");
}
async function sendPong(id, pingServer, ms) {
    await client.sendEvent(
        ROOM_ID,
        "dev.zirco.albedo.pong",
        { id, ping_server: pingServer, ms },
        "",
    );
    console.log(`Sent pong event back to ${pingServer} with latency ${ms}ms.`);
}

// On SIGINT or SIGTERM, send a leave event to the room before exiting.
process.on("SIGINT", async () => {
    console.log("Received SIGINT, leaving room...");
    await leave();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    console.log("Received SIGTERM, leaving room...");
    await leave();
    process.exit(0);
});

// EVENT HANDLERS
client.on(mx.RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
    if (toStartOfTimeline) return; // Ignore old events when syncing.
    if (event.getAge() > 60000) return; // Ignore events older than 60 seconds because they may be stale.
    if (room.roomId !== ROOM_ID) return; // Ignore events from other rooms.

    const senderServer = eventSender(event);

    if (
        event.getType() === "dev.zirco.albedo.register.reject" &&
        event.getContent().user === USER_ID
    ) {
        console.warn(
            `Registration rejected by CS: ${event.getContent().reason}, leaving room.`,
        );
        return;
    }

    if (event.getType() === "dev.zirco.albedo.ping") {
        if (!isParticipant(senderServer)) {
            console.warn(
                `Received ping from non-participant server ${senderServer}, ignoring.`,
            );
            return;
        }
        if (senderServer === SERVER_NAME) return;

        const id = event.getContent().id;
        const originTs = event.getTs();
        const now = Date.now();
        const latency = now - originTs;
        console.log(
            `Received ping from ${senderServer} with id ${id}, latency is ${latency}ms.`,
        );
        sendPong(id, senderServer, latency);
    }

    if (event.getType() === "dev.zirco.albedo.round.start") {
        if (event.getContent().server !== SERVER_NAME) return;

        console.log("Received round start event, sending ping...");
        const id = event.getContent().id;
        sendPing(id);
    }
});
