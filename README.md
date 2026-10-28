# homebridge-roborock-miio-matter

Homebridge plugin that puts a **Roborock vacuum paired with the Xiaomi Home
app** — the S5 (S50/S55), S6, Mi Robot Vacuum and other miIO-based models —
into Apple Home as a **native robot vacuum**, not a switch or a fan.

Apple Home only supports robot vacuums over Matter (iOS 18.4 and later), so the
plugin uses Homebridge 2's Matter support and publishes the robot as a
standalone Matter robotic vacuum. You get:

| Apple Home | What it does |
| --- | --- |
| **Start / Pause / Resume** | Whole-home clean, or the rooms you picked |
| **Send to Dock** | Stops and returns to the charger |
| **Rooms** | Clean only the selected rooms (needs a saved map with rooms) |
| **Clean mode** | Suction: Quiet, Balanced, Turbo, Max, and Mop on newer firmware |
| **Battery** | Level and charging state |
| **Identify** | The robot says "I'm over here" |

It also works with Siri and with Google Home, Alexa and SmartThings, since it
is plain Matter.

## Why this plugin

Robots on the Roborock app can use the Roborock-cloud plugins
(`homebridge-roborock-vacuum2` and friends). Robots on **Xiaomi Home** live on
Xiaomi's cloud instead, and some of them (the original S5 among them) cannot
be moved to the Roborock app at all. This plugin talks to those robots
directly on the local network over miIO, so it needs no cloud account at
runtime and keeps working without internet access.

## Requirements

- Homebridge **2.0 or later** with Matter (tested on 2.4.0)
- An Apple Home hub (Apple TV or HomePod) on **iOS/tvOS 18.4** or later
- The robot's **IP address** and **miIO token**

### Getting the token

The token is a 32-character hex string that encrypts the local protocol. The
robot hands it to the Xiaomi cloud when it is paired, so it can be read from
your Xiaomi account with
[Xiaomi-cloud-tokens-extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor):

```bash
# Linux/macOS, needs Python 3
bash <(curl -L https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor/raw/master/run.sh)
```

Sign in with your Xiaomi account, pick your server region, and note the
robot's IP and token. The token changes whenever the robot is reset or
re-paired in Xiaomi Home.

## Install

Not on npm — install it straight from this repository:

```bash
sudo npm install -g --prefix /usr git+https://github.com/gklka/homebridge-roborock-miio-matter.git
```

Adjust `--prefix` to wherever your Homebridge loads global modules from
(`/usr` suits an `hb-service` install on Debian/Ubuntu; plain `npm install -g`
is right for most others).

Check that the robot answers before configuring Homebridge:

```bash
roborock-miio-probe --discover
roborock-miio-probe --host 192.168.0.50 --token 0123456789abcdef0123456789abcdef
```

The second command prints the model, firmware, state, battery and the room
segments on the saved map. A *checksum mismatch* means the token is wrong.

## Configure

The plugin must run as a **child bridge with Matter enabled**. In the Homebridge
UI: **Plugins → Roborock (Xiaomi Home) Matter Vacuum → Settings**, enter the
name, IP and token, then open **Bridge Settings** for the plugin, turn on the
child bridge and enable Matter. Restart Homebridge.

Or in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "RoborockMiio",
      "name": "Roborock",
      "host": "192.168.0.50",
      "token": "0123456789abcdef0123456789abcdef",
      "rooms": [
        { "segment": 16, "name": "Kitchen" },
        { "segment": 17, "name": "Living Room" }
      ],
      "_bridge": {
        "username": "0E:12:34:56:78:9A",
        "port": 51830,
        "name": "Roborock",
        "hap": { "enabled": false },
        "matter": { "enabled": false, "externalsOnly": true }
      }
    }
  ]
}
```

`"matter": { "enabled": false, "externalsOnly": true }` runs Matter without an
empty Matter *bridge* next to the vacuum, and `"hap": { "enabled": false }` does
the same for HomeKit — the vacuum is the only thing this child bridge
publishes. (`"matter": {}` works too, but then the UI also offers an empty
Matter bridge for pairing.)

### Pairing with Apple Home

Apple Home needs a robot vacuum to be its own Matter device rather than a
device behind a bridge, so Homebridge gives it a pairing code of its own. Find
it in the Homebridge UI (the plugin's child bridge, Matter section) or in the
log, under *MATTER COMMISSIONING INFORMATION*, after the line
*External Matter accessory published*. In the Home app: **+ → Add Accessory →
More options…**, and scan the QR code or type the manual code.

The pairing is tied to the robot's device id, so it survives restarts and
plugin updates.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | `Roborock` | Name in Apple Home and in the log. |
| `host`, `token` | – | The robot's IP address and miIO token. Required. If the robot stops answering at `host`, the plugin searches the network for the device that answers to the token and switches to it (logging the new address), so a changed DHCP lease heals itself; a fixed lease still saves the search after a restart. |
| `rooms` | `[]` | Names for the room segments, as `{ "segment": 16, "name": "Kitchen" }`. See below. |
| `unnamedRooms` | `true` | Offer segments without a configured name as "Room *n*". `false` offers only the named ones. |
| `pollInterval` | `10` | Seconds between status reads (minimum 5). The robot is polled again right after every command. |
| `extendedStates` | `false` | Also report *returning to dock*, *charging*, *docked* and error reasons. Off by default because Apple Home has been seen refusing to pair vacuums that advertise more than the four basic states. Remove and re-pair the vacuum after changing it. |

### Rooms

The robot stores its rooms as numbered segments; the names you gave them in
Xiaomi Home live in the Xiaomi cloud and are not available locally. The probe
lists the segments, and can send the robot to one so you can see which room it
is:

```bash
roborock-miio-probe --host <ip> --token <token>                    # lists segments, e.g. 16, 17, 18
roborock-miio-probe --host <ip> --token <token> --clean-room 16    # watch where it goes
roborock-miio-probe --host <ip> --token <token> --dock
```

Room cleaning needs firmware with room support (recent S5 firmware has it) and a saved
map divided into rooms, set up in Xiaomi Home. Without one, the Rooms option
simply does not appear in Apple Home.

**Rooms without names.** Older firmware (S5 3.5.8, for one) divides the map into
rooms but only reports the rooms that have been given a name in Xiaomi Home, and
some app versions offer no way to name them. The robot then lists no rooms at
all, although cleaning by segment works fine. In that case the plugin takes the
segments in `rooms` on trust. Segments are usually numbered from 16 upwards,
but low numbers (1, 2, …) occur too; find out which is which with `--clean-room`.

## How it maps

| Robot | Matter operational state | Run mode |
| --- | --- | --- |
| cleaning, spot, zoned, room clean, going to target | Running | Cleaning |
| paused | Paused | Cleaning |
| returning home / docking | Running (*Seeking charger* with `extendedStates`) | Cleaning |
| charging / fully charged | Stopped (*Charging* / *Docked* with `extendedStates`) | Idle |
| error | Stopped (*Error* with the reason with `extendedStates`) | Idle |

| Clean mode | `fan_power`, firmware ≥ 3.5.7 | `fan_power`, older firmware |
| --- | --- | --- |
| Quiet | 101 | 38 |
| Balanced | 102 | 60 |
| Turbo | 103 | 75 |
| Max | 104 | 100 |
| Mop | 105 | – |

The firmware generation is recognised from the value the robot reports.

Commands from the Home app: **Start** sends `app_start`, or
`app_segment_clean` with the selected rooms; **Pause** sends `app_pause`;
**Resume** continues a paused whole-home or room clean (`app_start` /
`resume_segment_clean`); **Send to Dock** pauses a running robot and sends
`app_charge`; choosing **Idle** stops it in place (`app_stop`).

## Development

```bash
npm test    # miIO protocol against a simulated robot, state mapping, command handling
```

| File | Role |
| --- | --- |
| `lib/miio.js` | miIO client: handshake, AES-128-CBC packets, retries, discovery. No dependencies. |
| `lib/vacuum.js` | Roborock commands and status/error codes. |
| `lib/matter-state.js` | Pure mapping from robot status to the Matter clusters. |
| `lib/platform.js` | Matter registration, polling, command handlers. |
| `bin/roborock-miio-probe.js` | Setup and diagnostic CLI. |

The miIO protocol and Roborock command set follow
[python-miio](https://github.com/rytilahti/python-miio).

## License

MIT
