'use strict';
// Tiny mDNS/DNS-SD responder that advertises the _airplay._tcp and _raop._tcp services.
// One multicast socket per IPv4 interface, so the iPhone gets an address it can actually reach.
const os = require('os');
const makeMdns = require('multicast-dns');
const { EventEmitter } = require('events');

const TTL = 120;
const HOST_TTL = 120;

function isUsableIPv4(addr) {
  return addr.family === 'IPv4' || addr.family === 4;
}

class Advertiser extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts; // { name, hostLabel, port, airplayTxt, raopTxt, raopPrefix }
    this.instances = new Map(); // ip -> mdns
    this.timer = null;
  }

  get airplayInstance() { return `${this.opts.name}._airplay._tcp.local`; }
  get raopInstance() { return `${this.opts.raopPrefix}@${this.opts.name}._raop._tcp.local`; }
  get hostName() { return `${this.opts.hostLabel}.local`; }

  start() {
    this.refreshInterfaces();
    // Interfaces come and go (Wi-Fi reconnects, VPNs) — re-check periodically and re-announce.
    this.timer = setInterval(() => {
      this.refreshInterfaces();
      for (const [ip, m] of this.instances) this.announce(m, ip);
    }, 30000);
  }

  stop() {
    clearInterval(this.timer);
    for (const [ip, m] of this.instances) {
      try { this.announce(m, ip, 0); } catch (_) { /* ignore */ }
      setTimeout(() => { try { m.destroy(); } catch (_) { /* ignore */ } }, 300);
    }
    this.instances.clear();
  }

  update(opts) {
    // Send goodbye for old names, then announce the new ones.
    for (const [ip, m] of this.instances) { try { this.announce(m, ip, 0); } catch (_) { /* ignore */ } }
    this.opts = { ...this.opts, ...opts };
    setTimeout(() => { for (const [ip, m] of this.instances) this.announce(m, ip); }, 400);
  }

  listAddresses() {
    const out = [];
    const ifs = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifs)) {
      for (const a of addrs || []) {
        if (!isUsableIPv4(a) || a.internal) continue;
        if (a.address.startsWith('169.254.')) continue;
        out.push({ ifname: name, address: a.address, netmask: a.netmask });
      }
    }
    return out;
  }

  refreshInterfaces() {
    const current = new Set();
    for (const { address } of this.listAddresses()) {
      current.add(address);
      if (this.instances.has(address)) continue;
      let m;
      try {
        m = makeMdns({ interface: address, bind: '0.0.0.0', reuseAddr: true, loopback: !!process.env.MIRRORLY_MDNS_LOOPBACK, multicast: true });
      } catch (e) {
        this.emit('log', `mDNS: не вдалося відкрити інтерфейс ${address}: ${e.message}`);
        continue;
      }
      m.on('error', e => this.emit('log', `mDNS ${address}: ${e.message}`));
      m.on('warning', e => this.emit('log', `mDNS ${address}: ${e.message}`));
      m.on('query', (q, rinfo) => this.onQuery(m, address, q, rinfo));
      m.on('ready', () => this.announce(m, address));
      this.instances.set(address, m);
      this.emit('log', `mDNS: реклама на ${address}`);
    }
    for (const [ip, m] of this.instances) {
      if (!current.has(ip)) {
        try { m.destroy(); } catch (_) { /* ignore */ }
        this.instances.delete(ip);
      }
    }
  }

  records(ip, ttl = TTL) {
    const o = this.opts;
    const txt = obj => Object.entries(obj).map(([k, v]) => Buffer.from(`${k}=${v}`, 'utf8'));
    return {
      airplayPtr: { name: '_airplay._tcp.local', type: 'PTR', ttl, data: this.airplayInstance },
      raopPtr: { name: '_raop._tcp.local', type: 'PTR', ttl, data: this.raopInstance },
      airplaySrv: { name: this.airplayInstance, type: 'SRV', ttl: HOST_TTL, flush: true, data: { port: o.port, weight: 0, priority: 0, target: this.hostName } },
      raopSrv: { name: this.raopInstance, type: 'SRV', ttl: HOST_TTL, flush: true, data: { port: o.port, weight: 0, priority: 0, target: this.hostName } },
      airplayTxt: { name: this.airplayInstance, type: 'TXT', ttl, flush: true, data: txt(o.airplayTxt) },
      raopTxt: { name: this.raopInstance, type: 'TXT', ttl, flush: true, data: txt(o.raopTxt) },
      a: { name: this.hostName, type: 'A', ttl: HOST_TTL, flush: true, data: ip },
      enumA: { name: '_services._dns-sd._udp.local', type: 'PTR', ttl, data: '_airplay._tcp.local' },
      enumR: { name: '_services._dns-sd._udp.local', type: 'PTR', ttl, data: '_raop._tcp.local' },
    };
  }

  announce(m, ip, ttl) {
    const r = this.records(ip, ttl === undefined ? TTL : ttl);
    const answers = [r.airplayPtr, r.raopPtr, r.airplaySrv, r.raopSrv, r.airplayTxt, r.raopTxt, r.a];
    if (ttl === 0) for (const a of answers) a.ttl = 0;
    m.respond({ answers }, err => { if (err) this.emit('log', `mDNS announce ${ip}: ${err.message}`); });
  }

  onQuery(m, ip, query, rinfo) {
    const r = this.records(ip);
    const answers = [];
    const additionals = [];
    const lc = s => String(s).toLowerCase();
    const add = (list, rec) => { if (!list.includes(rec)) list.push(rec); };
    for (const q of query.questions || []) {
      const name = lc(q.name);
      const type = q.type;
      const any = type === 'ANY';
      if (name === '_airplay._tcp.local' && (type === 'PTR' || any)) {
        add(answers, r.airplayPtr); add(additionals, r.airplaySrv); add(additionals, r.airplayTxt); add(additionals, r.a);
      } else if (name === '_raop._tcp.local' && (type === 'PTR' || any)) {
        add(answers, r.raopPtr); add(additionals, r.raopSrv); add(additionals, r.raopTxt); add(additionals, r.a);
      } else if (name === lc(this.airplayInstance)) {
        if (type === 'SRV' || any) { add(answers, r.airplaySrv); add(additionals, r.a); }
        if (type === 'TXT' || any) add(answers, r.airplayTxt);
      } else if (name === lc(this.raopInstance)) {
        if (type === 'SRV' || any) { add(answers, r.raopSrv); add(additionals, r.a); }
        if (type === 'TXT' || any) add(answers, r.raopTxt);
      } else if (name === lc(this.hostName) && (type === 'A' || any)) {
        add(answers, r.a);
      } else if (name === '_services._dns-sd._udp.local' && (type === 'PTR' || any)) {
        add(answers, r.enumA); add(answers, r.enumR);
      }
    }
    if (!answers.length) return;
    const extra = additionals.filter(a => !answers.includes(a));
    // QU questions (unicast-response bit) get answered directly as well.
    const unicast = (query.questions || []).some(q => q.class === 'UNKNOWN_32769' || q.unicast_response || q.qu);
    m.respond({ answers, additionals: extra }, err => { if (err) this.emit('log', `mDNS respond: ${err.message}`); });
    if (unicast && rinfo) {
      try { m.respond({ answers, additionals: extra }, { port: rinfo.port, address: rinfo.address }); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = { Advertiser };
