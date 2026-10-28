'use strict';

/**
 * 相亲扩展入口
 *
 * 挂载点 /blinddate：
 *   API   /api/blinddate/*
 *   静态  /blinddate/client.js、/blinddate/style.css、/blinddate/panel.html
 *
 * 数据库文件：<dataDir>/blindDate.db
 * 首次建库会把默认表头写入第一行，启动时打印表头与数据行数。
 */

const path = require('path');
const { createStore } = require('./db');
const { createBlindDateRoutes } = require('./routes');

module.exports = {
  name: 'blindDate',
  mount: '/blinddate',

  create({ dataDir, broadcast, readBody, sendJSON }) {
    const dbPath = path.join(dataDir, 'blindDate.db');
    const store = createStore(dbPath);

    const snap = store.snapshot();
    return {
      name: 'blindDate',
      mount: '/blinddate',
      staticDir: __dirname,
      handle: createBlindDateRoutes({
        store,
        readBody,
        sendJSON,
        onChange: (data) => broadcast({ type: 'blinddate', data }),
      }),
      store,
    };
  },
};
