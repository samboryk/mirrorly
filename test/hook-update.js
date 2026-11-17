const fs = require('fs');
module.exports = ({ app, win }) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const js = c => win.webContents.executeJavaScript(c);
  const states = [];
  const { ipcMain } = require('electron');
  const orig = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, d) => { if (ch === 'update' && states[states.length - 1] !== d.status) states.push(d.status); return orig(ch, d); };
  (async () => {
    await wait(+(process.env.WAIT || 9000));
    console.log('STATES', states.join(' > '));
    console.log('UI status:', await js("document.getElementById('u-status').textContent"), '| banner hidden:', await js("document.getElementById('upd-banner').hidden"), '| btn:', await js("document.getElementById('u-action').textContent"));
    if (process.env.SHOTS) {
      fs.writeFileSync('/tmp/shots/u-idle.png', (await win.webContents.capturePage()).toPNG());
      await js("document.body.classList.add('sheet-open')"); await wait(900);
      fs.writeFileSync('/tmp/shots/u-settings1.png', (await win.webContents.capturePage()).toPNG());
      await js("document.querySelector('.sheet-body').scrollTop=520"); await wait(400);
      fs.writeFileSync('/tmp/shots/u-settings2.png', (await win.webContents.capturePage()).toPNG());
    }
    app.exit(0);
  })();
};
