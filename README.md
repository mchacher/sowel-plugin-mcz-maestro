# sowel-plugin-mcz-maestro

Sowel integration for MCZ pellet stoves, through the MCZ Maestro cloud.

It polls the stove (state, room temperature, setpoint, profile, eco mode, pellet sensor, ignition count, spark plug) and sends the orders the Maestro app offers: power, setpoint, profile, eco mode and alarm reset.

## Settings

| Setting | Meaning |
|---|---|
| Serial number, MAC address | The stove's identifiers, as shown in the Maestro app. Required. |
| Polling interval (seconds) | Default 300, minimum 60. |
| Profile at each start | `comfort`, `dynamic` or `overnight`. Empty: left as it is. |
| Eco mode at each start | `on` or `off`. Empty: left as it is. |

### Profile and eco mode at each start

After an alarm reset (an `A01` or `A02` once the pellets are refilled, for instance) the stove comes back in the manual profile with eco mode off. With the two start-up settings filled in, the plugin puts it back in the chosen profile and eco mode each time the stove starts:

- A start is the stove going from off or from an alarm to any active step (check, ignition, running), even when the ignition falls between two polls.
- Relighting after a pause in eco or standby is not a start: a profile chosen by hand while the stove runs stays as it is until it is switched off or stops on an alarm.
- Only what differs is sent, then checked a few seconds later, up to three times. If the stove has not taken it after three tries, or within two minutes of the start, the plugin logs a warning and leaves it as it is until the next start.
- The first poll after Sowel starts is never taken for a start.
