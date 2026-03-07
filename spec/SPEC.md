# Albedo 1.0

Automated Matrix federation latency monitoring.

Albedo is a protocol for automatically measuring federation latency across Matrix servers. A single
**Central Station (CS)** manages measurement rounds and collection of data, with participating
servers responding to lightweight pings to build a full latency matrix across the network.

The protocol ensures only one server is pinging at a given time to ensure accuracy of ping information.

---

## Roles

### Central Station (CS)

The CS is a single trusted server who orchestrates the time slots that participating nodes (PNs) ping
within. It also aggregates data and manages up/down monitoring for PNs.

### Participating Node (PN)

A PN is any server that has registered with the CS and actively takes part in measurement rounds.
Each server name (as defined by the Matrix spec) may have at most one actively registered bot.
If a server wishes to deregister an unauthorized PN, it should contact the maintainer of the CS, or
simply force the member to leave the Albedo room.

### Observer

Any other user in the room that is not the CS or an actively registered PN. Observers may consume
information included in the events provided by the CS and active PNs to monitor the health of the
Matrix network.

---

## Room Configuration

The Albedo room should be a dedicated, low-traffic room used exclusively for Albedo protocol events.
Any unnecessary activity in the room may result in inaccurate results.

### Power Levels

The key roles in the Albedo protocol are associated with power levels:

| Role                     | Power Level |
| ------------------------ | ----------- |
| CS                       | 80          |
| PN                       | 20          |
| Previously-registered PN | 10          |

Power level requirements are assigned per event type:

| Event                              | Required PL |
| ---------------------------------- | ----------- |
| `dev.zirco.albedo.roster`          | 80 (CS)     |
| `dev.zirco.albedo.register.reject` | 80 (CS)     |
| `dev.zirco.albedo.round.start`     | 80 (CS)     |
| `dev.zirco.albedo.round.complete`  | 80 (CS)     |
| `dev.zirco.albedo.ping`            | 20 (PN)     |
| `dev.zirco.albedo.pong`            | 20 (PN)     |
| `dev.zirco.albedo.register`        | See below   |
| `dev.zirco.albedo.leave`           | See below   |

It is recommended to place room administrators at PL 90 and moderators at PL 50. Moderators
of an Albedo room may choose to selectively allow servers to participate in the protocol by
raising the required power level for PN registration above the recommended default of 0. When a
PN leaves the roster, it will be placed at PL 10 to accommodate this.

Homeservers enforce these power levels, allowing for protocol level rejection of invalid events from
non-participating servers.

---

## State Events

### `dev.zirco.albedo.roster`

This event, maintained exclusively by the CS, contains the list of actively registered PNs.
This is the single source of truth for if a PN is active and should expect to receive rounds and
respond to pings by other servers.

If a server is removed from this list, it either left or was evicted. If a server was added, then it is
now a freshly registered PN.

Although the sender of the current roster often represents the live CS, events sent by other
nodes with appropriate power should be respected.

```json
{
    "participants": [
        "server-a.example.com",
        "server-b.example.com",
        "server-c.example.com"
    ]
}
```

---

## Protocol Events

### `dev.zirco.albedo.register`

Sent by an Observer to register themselves as a PN.

It will be rejected by the CS if it matches any of the reasons for rejection below.

A rejection is indicated by the `dev.zirco.albedo.register.reject` event. It is confirmed by the
sending of an updated `dev.zirco.albedo.roster` event by the CS.

The PN must provide a list of its additional protocol "capabilities," which will be used in
future versions of the spec, alongside information on its PN implementation and version.

```json
{
    "capabilities": [],
    "user_agent": "albedo-pn-js/1.0.0"
}
```

### `dev.zirco.albedo.register.reject`

Sent by the CS if rejecting a prospective PN’s `dev.zirco.albedo.register` event.

See the possible reasons for rejection below. The textual `reason` included in the event
may not match the Human-Readable Reason defined below. Implementations may add
their own set of rejection codes, and should prefix them with their own reverse-DNS namespace
similar to other custom Matrix events.

| Rejection Code                        | Human-Readable Reason                                    |
| ------------------------------------- | -------------------------------------------------------- |
| `dev.zirco.albedo.ALREADY_REGISTERED` | This node is already a registered PN                     |
| `dev.zirco.albedo.DUPLICATE_SERVER`   | There is already a registered PN for this homeserver     |
| `dev.zirco.albedo.FORBIDDEN`          | This user or server is not permitted to register as a PN |

The `dev.zirco.albedo.FORBIDDEN` code may be used by CSes which wish to permanently block
a given user on a server (e.g. by request from a homeserver operator) or whitelist individual servers
and nodes (without using power levels as previously described).

```json
{
    "code": "dev.zirco.albedo.FORBIDDEN",
    "reason": "User @albedo:example.com is forbidden from this room!",
    "user": "@albedo:example.com"
}
```

### `dev.zirco.albedo.leave`

Sent by a PN wishing to convert back to an observer and be removed from a roster.
When able, a PN that is shutting down must send this event to ensure room consistency.

If sent by an observer, this event is ignored. It is confirmed by the sending of an updated
`dev.zirco.albedo.roster` event by the CS.

```json
{}
```

### `dev.zirco.albedo.round.start`

Sent by the CS to command a PN to execute a ping. When it receives this event, the PN
must immediately send a `dev.zirco.albedo.ping` event with the same ID. If it fails to do so
within a CS-defined timeout, the CS may evict (deregister) it. Only registered PNs receive
round events.

The ID may be any implementation-defined string, but it must be preserved in the ping event.

```json
{
    "id": "<string>",
    "server": "ping-server.com"
}
```

### `dev.zirco.albedo.ping`

Sent by the CS or any PN (upon round trigger) to measure the one-way ping between the ping
node and the pong node. It may only be sent by an active, participating PN.

```json
{
    "id": "<string>"
}
```

### `dev.zirco.albedo.pong`

Sent in response to a valid ping from the CS or any PN to measure the one-way ping from the
ping node. The same `id` from the sending ping event is preserved. It may only be sent by
an active, participating PN.

The response to a ping should be as follows, with `400` representing the difference in wall
clock time from the origin server timestamp of the `ping` event. The wall clock MUST be synchronized.

If a server fails to pong and times out, it will be evicted.
A PN should not respond to itself.

```json
{
    "ping_server": "ping-server.com",
    "pong_server": "pong-server.com",
    "ms": 400,
    "id": "<string>"
}
```

### `dev.zirco.albedo.round.complete`

Sent by the CS once a round is fully complete. This is observed by all active PNs sending pong replies,
or by a timeout. It references all pongs in `prev_events` to reduce room extremity count.

```json
{
    "id": "<string>",
    "ping_server": "ping-server.com",
    "pongs": {
        "server-a.com": null, // the PN timed out
        "server-b.com": 400
    }
}
```

The CS may include additional statistical information, but this is information defined.

## Round Lifecycle

```
CS:    round.start    { id: 1, server: A }
PN A:  ping           { id: 1 }
PN B:  pong           { id: 1, ms: 200 }
PN C:  pong           { id: 1, ms: 200 }
CS:    round.complete { id: 1, pongs: { B: 200, C: 200 } }
CS:    round.start    { id: 2, server: B }
```

## Extensibility

All events may include additional fields. Servers should ignore any events they aren’t aware of.
