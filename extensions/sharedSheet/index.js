'use strict';

/**
 * 共享表格扩展入口
 *
 * 挂载点 /sharedsheet：
 *   API   /api/sharedsheet/*
 *   静态  /sharedsheet/client.js、/sharedsheet/style.css、/sharedsheet/panel.html
 *
 * 数据库文件：<dataDir>/sharedsheet.db
 * 用户新建的每张表格都是库里的一张同名数据表；启动时打印已有表格。
 */

const path = require('path');
const { createStore } = require('./db');
const { createSharedSheetRoutes } = require('./routes');

module.exports = {
  name: 'sharedsheet',
  mount: '/sharedsheet',

  create({ dataDir, broadcast, readBody, sendJSON }) {
    const dbPath = path.join(dataDir, 'sharedsheet.db');
    const store = createStore(dbPath);

    const sheets = store.listSheets();

    return {
      name: 'sharedsheet',
      mount: '/sharedsheet',
      staticDir: __dirname,
      handle: createSharedSheetRoutes({
        store,
        readBody,
        sendJSON,
        onChange: (data) => broadcast({ type: 'sharedsheet', data }),
      }),
      store,
    };
  },
};
