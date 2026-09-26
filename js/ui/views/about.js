// About: bit notation, architectures, disclaimer.

import { html, setHtml } from '../dom.js';
import { renderGrid, hueMap } from '../bitgrid.js';
import { normalizeFrame } from '../../core/normalize.js';

let demo = null;
function demoFrame() {
  if (demo) return demo;
  demo = normalizeFrame({
    id: 0x0B6, name: 'EXAMPLE', type: 'can', length: 4,
    signals: {
      ENGINE_RPM: { bits: '1.7-2.3', factor: 0.125, units: 'rpm' },
      FLAG: { bits: '2.2' },
      UNUSED_1: { bits: '2.1-2.0', unused: true },
      SPEED: { bits: '3.7-4.0', factor: 0.01, units: 'km/h' },
    },
  });
  Object.assign(demo, { archvar: 'X', netbus: 'X', idHex: '0B6', key: 'demo', uid: 'demo' });
  return demo;
}

export function renderAbout(root) {
  const f = demoFrame();
  setHtml(root, html`<div class="page about">
    <h2>About OpenLEO Explorer</h2>
    <p>This is a browser for the <a href="https://github.com/prototux/PSA-RE" target="_blank" rel="noopener">PSA-RE</a> reverse engineering database of the Peugeot / Citroën / DS electronic architectures, written in the DBMUXEv YAML format. It is meant for people building devices or software that talk to these cars: custom ECUs, diagnostic tools, CAN/VAN/LIN sniffers, dashboards, retrofits…</p>
    <div class="notice danger"><b>Disclaimer.</b> This is unofficial, community reverse engineered data: it may be incomplete or wrong, and it is provided without any warranty. Use it at your own risk. Transmitting on a car network can make ECUs misbehave; the <b>HS / IS (inter-systems) bus is safety critical</b> (engine, ABS/ESP, power steering, airbags): never transmit on it on a moving vehicle, and be very careful with the wiring (a short can destroy transceivers or ECUs). Peugeot, Citroën and DS are trademarks of their owners; this project is not affiliated with them.</div>

    <h3>Bit notation</h3>
    <p>Signals are written <code>&lt;byte&gt;.&lt;bit&gt;</code>: bytes are numbered from <b>1</b> (the first transmitted byte), bits from <b>7</b> (most significant, first transmitted) to <b>0</b>. A range <code>&lt;start&gt;-&lt;end&gt;</code> is given in transmission order, big endian (Motorola): <code>1.7-2.0</code> is a 16 bit value whose most significant byte is byte 1. <code>3.7-n</code> means "from byte 3 to the end of the (variable length) payload". Rare little endian values are flagged with <code>byte_order: little_endian</code> (the least significant byte comes first).</p>
    <p><code>physical = raw × factor + offset</code>; <code>sint</code> values are two's complement; <code>invalid</code> lists raw values meaning "not available"; <code>values</code> maps raw values to their meaning.</p>
    <div style="max-width:720px">${renderGrid(f, f.signals, { hues: hueMap(f.signals) })}</div>
    <p class="small muted">Example: ENGINE_RPM <code>1.7-2.3</code> is 13 bits (byte 1 + the 5 high bits of byte 2). In a DBC file it is <code>7|13@0+</code> (Motorola start bit = MSB position in the DBC "sawtooth" numbering). The Tools tab has a converter between the notations.</p>

    <h3>Architectures</h3>
    <table class="tbl"><thead><tr><th>Architecture</th><th>What</th></tr></thead><tbody>
      <tr><td class="mono">AEE2001</td><td>VAN + CAN (≈1998-2008: 206, 307, C5, Xsara Picasso, 406/607…). Comfort and body functions on VAN buses (VAN CONF, VAN CAR), engine/gearbox/ABS on CAN inter-systems.</td></tr>
      <tr><td class="mono">AEE2004</td><td>First full-CAN architecture (2004+: 407, 207, C4, 307 phase 2…): HS.IS (500 kbit/s) and low speed LS.CONF / LS.CAR (125 kbit/s) plus LIN. The <code>ev</code> variant is the 2007 <i>évolution</i> ("AEE2004-2007"), not an electric vehicle.</td></tr>
      <tr><td class="mono">AEE2010</td><td>Second generation full-CAN architecture (2010+), with many more buses and variants (full, eco, ev = évolution).</td></tr>
      <tr><td class="mono">none / partners</td><td>Some cars are not multiplexed (<code>architecture: none</code>), others come from partners (Mitsubishi MMC, Fiat, Toyota) and are not documented here.</td></tr>
    </tbody></table>
    <p>The BSI (<i>Boîtier de Servitude Intelligent</i>, "built-in systems interface") is the central gateway of AEE2001/2004 cars: it is connected to every bus and forwards data between them.</p>

    <h3>Using the explorer</h3>
    <ul>
      <li><b>Frames</b>: filter by architecture, bus, ECU, type… Each frame has a bit grid, an simple (byte by byte) description, decoder, encoder (with <code>cansend</code>, Arduino and ESP32 snippets) and C / Python / DBC code.</li>
      <li><b>Cars</b>: find your car by project code or name, see its architecture, ECUs and the frames you should see on it.</li>
      <li><b>ECUs</b>: what each ECU sends and receives, and a checklist to emulate it.</li>
      <li><b>Diagnostics</b>: protocol reference, addressing, DTC lookup, ISO-TP request builder and the seed/key calculator.</li>
      <li><b>Tools</b>: log decoder (candump, SavvyCAN, Vector ASC), bit position converter, DBC / JSON export, bus load estimator and the data issues found while loading.</li>
      <li>Press <kbd>/</kbd> anywhere to search. Every page has a shareable URL.</li>
    </ul>

    <h3>Data</h3>
    <p>By default the data is loaded from GitHub (<code>prototux/PSA-RE</code>). Other sources (a fork, a local copy served over HTTP, a local folder, or several repositories at once) can be added in <a href="#/settings">settings</a>. Parsed data is cached in your browser (IndexedDB) until the repository changes. Data warnings (⚠ badges) show where the YAML does not follow the DBMUXEv format; the explorer tries to read it anyway.</p>
    <p class="muted small">Inspired by SavvyCAN and Vector CANdb++. The seed/key algorithm is ported from <code>PSA-RE/sandbox/uds_auth_algorithm.py</code>.</p>
  </div>`);
}
