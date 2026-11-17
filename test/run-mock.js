require('./mock-github')(process.argv[2]).then(u => { console.log(u); });
