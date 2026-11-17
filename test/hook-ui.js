const fs = require('fs');
module.exports = ({ app, win, send }) => {
  const shot = async name => { const img = await win.webContents.capturePage(); fs.writeFileSync(`/tmp/shots/${name}.png`, img.toPNG()); console.log('shot', name); };
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  win.webContents.on('console-message', (e) => console.log('renderer:', e.message || ''));
  (async () => {
    await wait(2500);
    await shot('1-idle');
    await js("document.body.classList.add('sheet-open')"); await wait(900);
    await shot('2-settings');
    await js("document.querySelector('.sheet-body').scrollTop=2000"); await wait(400);
    await shot('3-settings-bottom');
    await js("document.body.classList.remove('sheet-open')"); await wait(700);
    send('approval', { id: 'x1', name: 'iPhone (Дмитро)', model: 'iPhone17,1', address: '192.168.1.50' });
    await wait(900);
    await shot('4-alert');
    app.exit(0);
  })();
};
