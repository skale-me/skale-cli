#!/usr/bin/env node
'use strict';

// Copyright 2016 Luca-SAS, licensed under the Apache License 2.0

var child_process = require('child_process');
var fs = require('fs');
var net = require('net');
var DDPClient = require('ddp');
var login = require('ddp-login');
var netrc = require('netrc');

var help = 'Usage: skale [options] <command> [<args>]\n' +
'\n' +
'Create, test, deploy, run clustered NodeJS applications\n' +
'\n' +
'Commands:\n' +
'  create <app>        Create a new application\n' +
'  test [<args>...]    Run application on local host\n' +
'  deploy [<args>...]  Deploy application on skale cloud\n' +
'  run [<args>...]     Run application on skale cloud\n' +
'  attach              Attach to a running application\n' +
'  list                List deployed applications\n' +
'  log                 Print log of an application\n' +
'  signup              Create an account on skale cloud\n' +
'  status [<name>]     Print status of application on skale cloud\n' +
'  stop                Stop application on skale cloud\n' +
'\n' +
'Options:\n' +
'  -d, --debug         Enable debug traces\n' +
'  -f, --file          Set program to run (default: package name)\n' +
'  --force             Force action to occur, despite warning\n' +
'  -h, --help          Print help and quit\n' +
'  -m, --memory MB     Set the memory space limit per worker (default 4000 MB)\n' +
'  -r, --remote        Run in the cloud instead of locally\n' +
'  -V, --version       Print version and quit\n' +
'  -w, --worker num    Set the number of workers (default 2)\n';

var argv = require('minimist')(process.argv.slice(2), {
  string: [
    'c', 'config',
    'f', 'file',
    'm', 'memory',
    'w', 'worker',
  ],
  boolean: [
    'd', 'debug',
    'force',
    'h', 'help',
    'V', 'version',
  ],
  default: {}
});


if (argv.h || argv.help) {
  console.log(help);
  process.exit();
}
if (argv.V || argv.version) {
  var pkg = require('./package');
  console.log(pkg.name + '-' + pkg.version);
  process.exit();
}
if (argv.d || argv.debug) {
  process.env.SKALE_DEBUG = 2;
}

var configPath = argv.c || argv.config || process.env.SKALE_CONFIG || process.env.HOME + '/.skalerc';
var config = load_config(argv);
var proto = config.ssl ? require('https') : require('http');
var memory = argv.m || argv.memory || 4000;
var worker = argv.w || argv.worker || 2;
var rc = netrc();
var start = process.hrtime();
var trace;

if (process.env.SKALE_DEBUG > 1) {
  trace =  function() {
    var args = Array.prototype.slice.call(arguments);
    var elapsed = process.hrtime(start);
    args.unshift('[skale ' + (elapsed[0] + elapsed[1] / 1e9).toFixed(3) + 's]');
    console.error.apply(null, args);
  };
} else {
  trace = function () {};
}

switch (argv._[0]) {
  case 'attach':
    attach();
    break;
  case 'create':
    create(argv._[1]);
    break;
  case 'deploy':
    deploy(argv._.splice(1));
    break;
  case 'list':
    list(argv._.splice(1));
    break;
  case 'log':
    log.apply(null, argv._.splice(1));
    break;
  case 'run':
    run_remote(argv._.splice(1));
    break;
  case 'signup':
    console.log('signup: not implemented yet');
    break;
  case 'status':
    status(argv._[1]);
    break;
  case 'stop':
    stop();
    break;
  case 'test':
    run_local(argv._.splice(1));
	break;
  default:
    die('Error: invalid command: ' + argv._[0]);
}

function checkName(name) {
  return /^[A-Za-z][A-Za-z0-9_-]+$/.test(name);
}

function create(name) {
  if (!checkName(name)) die('skale create error: invalid name ' + name);
  console.log('create application ' + name);
  try {
    fs.mkdirSync(name);
  } catch (error) {
    die('skale create error: ' + error.message);
  }
  process.chdir(name);
  console.log('create local repository');
  try {
    child_process.execSync('git init');
  } catch (err) {
    console.log('It looks like you may not have git installed.  Skale needs that to run.  See https://git-scm.com/ for installation.');
    return;
  }

  var pkg = {
    name: name,
    version: '0.1.0',
    private: true,
    keywords: [ 'skale' ],
    dependencies: {
      'skale-engine': '^0.6.1'
    }
  };
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
  var src = '#!/usr/bin/env node\n' +
    '\n' +
    'var sc = require(\'skale-engine\').context();\n' +
    '\n' +
    'sc.parallelize([\'Hello world\']).collect().then(function (res) {\n' +
    ' console.log(sc.worker.length + \' workers, res:\', res);\n' +
    ' sc.end();\n' +
    '});\n';
  fs.writeFileSync(name + '.js', src);
  var gitIgnore = 'node_modules\nnpm-debug.log*\n.npm-install-changed.json\n';
  fs.writeFileSync('.gitignore', gitIgnore);
  var npm = child_process.spawnSync('npm', ['install'], {stdio: 'inherit'});
  if (npm.status) die('skale create error: npm install failed');


  console.log('\n----------------------------------' +
    '\nProject ' + name + ' is now ready!\n' +
    'Please change directory to ' + name + ': "cd ' + name + '"\n' +
    'To run your app locally: "skale test"\n' +
    'To modify your app edit the file called ' + name + '.js');
}

function die(err) {
  console.error(err);
  process.exit(1);
}

function load_config(argv) {
  var conf = {}, save = false;
  try { conf = JSON.parse(fs.readFileSync(configPath)); } catch (error) { save = true; }
  process.env.SKALE_TOKEN = process.env.SKALE_TOKEN || conf.token;
  if (save || argv._[0] == 'init') save_config(conf);
  return conf;
}

function save_config(config) {
  fs.writeFile(configPath, JSON.stringify(config, null, 2), function (err) {
    if (err) die('Could node write ' + configPath + ':', err);
  });
}

function status_local() {
  var child = child_process.execFile('/bin/ps', ['ux'], function (err, out) {
    var lines = out.split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++)
      if (i == 0 || lines[i].match(/ skale-/)) console.log(lines[i].trim());
  });
}

function run_local(args) {
  var pkg = JSON.parse(fs.readFileSync('package.json'));
  var cmd = argv.f || argv.file || pkg.name + '.js';
  args.splice(0, 0, cmd);
  child_process.spawn('node', args, {stdio: 'inherit'});
}

function skale_session(callback) {
  var host = process.env.SKALE_SERVER || 'apps.skale.me';
  var port = process.env.SKALE_PORT || 443;

  var ddp = new DDPClient({
    // All properties optional, defaults shown
    host : host,
    port : port,
    ssl  : !process.env.SKALE_NOSSL,
    autoReconnect : true,
    autoReconnectTimer: 500,
    maintainCollections : true,
    ddpVersion: '1',  // ['1', 'pre2', 'pre1'] available
    useSockJs: true,
    url: 'wss://example.com/websocket'
  });

  ddp.connect(function (err, isreconnect) {
    if (err) return callback(err, ddp, isreconnect);
    login(ddp, {env: 'SKALE_TOKEN', retry: 2}, function (err, userInfo) {
      if (err) return callback(err, ddp, isreconnect);
      var token = userInfo.token;
      if (userInfo.token != config.token) {
        config.token = userInfo.token;
        save_config(config);
      }
      trace('connected to', host, port);
      return callback(err, ddp, isreconnect);
    });
  });

  ddp.on('socker-close', function () {trace('disconnected');});
}

function deploy(args) {
  skale_session(function (err, ddp, isreconnect) {
    if (err) {
      switch (err.reason) {
      case 'User not found':
        die('User not found');
      default:
        die(err.toString());
      }
    }
    var pkg = JSON.parse(fs.readFileSync('package.json'));
    var name = pkg.name;

    ddp.call('etls.add', [{name: name}], function (err, res) {
      if (err) die('Could not create application ' + name + ':', err);
      trace('application added on server', name);
      var a = res.url.split('/');
      var login = a[a.length - 2];
      var host = a[2].replace(/:.*/, '');
      var passwd = res.token;
      rc[host] = {login: login, password: passwd};
      netrc.save(rc);
      child_process.exec('git remote remove skale; git remote add skale "' + res.url + '"; git add -A .; git commit -m "automatic commit"; git pull --rebase -Xours skale master; git push skale master', function (err, stdout, stderr) {
        if (err) die('deploy error: ' + err);
        trace('application transfered using git');
        ddp.call('etls.deploy', [{name: name}], function (err, res) {
          if (err) console.error(err);
          else console.log(name + ' deployed');
          trace('done');
          ddp.close();
        });
      });
    });
  });
}

function list(args) {
  skale_session(function (err, ddp, isreconnect) {
    if (err) die('Could not connect:', err);
    var user = Object.keys(ddp.collections.users)[0];
    ddp.subscribe('etls', [user], function () {
      var etls = ddp.collections.etls;
      for (var i in etls) console.log(etls[i].name);
      trace('done');
      ddp.close();
    });
  });
}

function run_remote(args) {
  try {
    var diff = child_process.execSync('git diff skale/master', {stdio: ['pipe', 'pipe', 'ignore']});
    if (diff.length) {
      if (argv.force) console.error('Warning, running an obsolete version, you should deploy');
      else die('Error: content has changed, deploy first or run --force');
    }
  } catch (err) {
    die('This application is not deployed. Run first "skale deploy"');
  }
  skale_session(function (err, ddp, isreconnect) {
    if (err) die('Could not connect:', err);
    var pkg = JSON.parse(fs.readFileSync('package.json'));
    var name = pkg.name;
    var opt = {debug: process.env.SKALE_DEBUG};
    var ltrace;

    trace('run triggered, wait for machine');
    ddp.call('etls.run', [{name: name, opt: opt}], function (err, res) {
      if (err) die('run error:', err);
      if (res.alreadyStarted) die('Error: application is already running, use "skale attach" or "skale stop"');
      ddp.subscribe('task.withTaskId', [res.taskId], function () {});

      var observer = ddp.observe('tasks');
      observer.added = function (id) {
        var task = ddp.collections.tasks[id];
        if (task.trace !== ltrace) {
          ltrace = task.trace;
          trace(ltrace);
        }
        //trace('added', ddp.collections.tasks[id]);
      };

      observer.changed = function (id, oldFields, clearedFields, newFields) {
        if (newFields.trace && newFields.trace !== ltrace) {
          ltrace = newFields.trace;
          trace(ltrace);
        }
        if (newFields.status === 'ok' || newFields.status === 'failed') {
          trace('job end', newFields.status);
          ddp.close();
        }
        if (newFields.out) {
          var olen = oldFields.out ? oldFields.out.length : 0;
          var nlen = newFields.out.length;
          for (var i = olen; i < nlen; i++) process.stdout.write(newFields.out[i] + '\n');
        }
      };
    });
  });
}

function attach() {
  skale_session(function (err, ddp, isreconnect) {
    if (err) die('Could not connect:', err);
    var pkg = JSON.parse(fs.readFileSync('package.json'));
    var name = pkg.name;
    ddp.subscribe('etls.withName', [name], function (err) {
      var etl = ddp.collections.etls[Object.keys(ddp.collections.etls)[0]];
      if (!etl.running) die('Application is not running, use "skale log" or "skale run"');

      ddp.subscribe('task.withTaskId', [etl.taskId], function () {
        var task = ddp.collections.tasks[Object.keys(ddp.collections.tasks)[0]];
        for (var i = 0; i < task.out.length; i++)
          console.log(task.out[i]);
      });

      var observer = ddp.observe('tasks');
      observer.changed = function (id, oldFields, clearedFields, newFields) {
        if (newFields.status && newFields.status != 'pending') ddp.close();
        if (newFields.out) {
          var olen = oldFields.out ? oldFields.out.length : 0;
          var nlen = newFields.out.length;
          for (var i = olen; i < nlen; i++) process.stdout.write(newFields.out[i] + '\n');
        }
      };

    });
  });
}

function log(name) {
  if (!name) {
    name = JSON.parse(fs.readFileSync('package.json')).name;
  }
  skale_session(function (err, ddp, isreconnect) {
    if (err) die('could not connect:', err);
    ddp.subscribe('etls.withName', [name], function () {
      var etl = ddp.collections.etls[Object.keys(ddp.collections.etls)[0]];
      ddp.subscribe('task.withTaskId', [etl.taskId], function () {
        var task = ddp.collections.tasks[Object.keys(ddp.collections.tasks)[0]];
        for (var i = 0; i < task.out.length; i++)
          console.log(task.out[i]);
        trace('done');
        ddp.close();
      });
    });
  });
}

function status(name) {
  skale_session(function (err, ddp, isreconnect) {
    if (err) die('could node connect:', err);
    if (!name) {
      try {
        var pkg = JSON.parse(fs.readFileSync('package.json'));
        name = pkg.name;
      } catch (err) {
        die('Could not find package.json.  You need to run this command from a skale project directory.')
      }
    }

    ddp.subscribe('etls.withName', [name], function (err, data) {
	  if (!ddp.collections.etls) die('etl not found:', name);
      var etl = ddp.collections.etls[Object.keys(ddp.collections.etls)[0]];
      console.log(etl.name, 'status:', etl.running ? 'running' : 'exited');
      ddp.close();
    });
  });
}

function stop() {
  skale_session(function (err, ddp, isreconnect) {
    if (err) die('could node connect:', err);
    var pkg = JSON.parse(fs.readFileSync('package.json'));
    var name = pkg.name;
    ddp.call('etls.reset', [{name: name, reset: argv.force}], function (err, res) {
      ddp.close();
    });
  });
}
