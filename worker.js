// 合并前后端的单一Worker解决方案

// D1 Table Schemas (for reference and creation)
const D1_SCHEMAS = {
  admin_credentials: `
    CREATE TABLE IF NOT EXISTS admin_credentials (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL
    );
    INSERT OR IGNORE INTO admin_credentials (username, password) VALUES ('admin', 'admin');
  `,
  servers: `
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      api_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      sort_order INTEGER,
      last_notified_down_at INTEGER DEFAULT NULL
    );
  `,
  metrics: `
    CREATE TABLE IF NOT EXISTS metrics (
      server_id TEXT PRIMARY KEY,
      timestamp INTEGER,
      cpu TEXT,
      memory TEXT,
      disk TEXT,
      network TEXT,
      ping TEXT, -- 新增：存储丢包率数据
      uptime INTEGER,
      FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `,
  monitored_sites: `
    CREATE TABLE IF NOT EXISTS monitored_sites (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      name TEXT,
      added_at INTEGER NOT NULL,
      last_checked INTEGER,
      last_status TEXT DEFAULT 'PENDING',
      last_status_code INTEGER,
      last_response_time_ms INTEGER,
      sort_order INTEGER,
      last_notified_down_at INTEGER DEFAULT NULL
    );
  `,
  site_status_history: `
    CREATE TABLE IF NOT EXISTS site_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      status TEXT NOT NULL,
      status_code INTEGER,
      response_time_ms INTEGER,
      FOREIGN KEY(site_id) REFERENCES monitored_sites(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_site_status_history_site_id_timestamp ON site_status_history (site_id, timestamp DESC);
  `,
  telegram_config: `
    CREATE TABLE IF NOT EXISTS telegram_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bot_token TEXT,
      chat_id TEXT,
      enable_notifications INTEGER DEFAULT 0,
      updated_at INTEGER
    );
    INSERT OR IGNORE INTO telegram_config (id, bot_token, chat_id, enable_notifications, updated_at) VALUES (1, NULL, NULL, 0, NULL);
  `,
  app_config: `
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT OR IGNORE INTO app_config (key, value) VALUES ('vps_report_interval_seconds', '60');
  `
};

// Helper to ensure all tables exist
async function ensureTablesExist(db) {
  console.log("Ensuring all database tables exist...");
  const createTableStatements = Object.values(D1_SCHEMAS).map(sql => db.prepare(sql));
  try {
    await db.batch(createTableStatements);
    console.log("Database tables verified/created successfully.");
  } catch (error) {
    console.error("Error during initial table creation:", error);
  }

  // Attempt to add new columns to existing tables if they are missing
  console.log("Attempting to apply schema alterations for new columns...");
  const alterStatements = [
    "ALTER TABLE monitored_sites ADD COLUMN last_notified_down_at INTEGER DEFAULT NULL",
    "ALTER TABLE servers ADD COLUMN last_notified_down_at INTEGER DEFAULT NULL",
    "ALTER TABLE metrics ADD COLUMN uptime INTEGER DEFAULT NULL",
    "ALTER TABLE metrics ADD COLUMN ping TEXT" // 新增 ping 字段
  ];

  for (const alterSql of alterStatements) {
    try {
      await db.exec(alterSql);
      console.log(`Successfully executed: ${alterSql}`);
    } catch (e) {
      if (e.message && (e.message.includes("duplicate column name") || e.message.includes("already exists"))) {
        // Expected if column exists
      } else if (e.message && e.message.includes("no such table")) {
        // Table doesn't exist yet, ignore
      } else {
        console.error(`Error executing ALTER statement "${alterSql}":`, e);
      }
    }
  }
}


// 处理API请求
async function handleApiRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  
  // 处理登录请求
  if (path === '/api/auth/login' && method === 'POST') {
    try {
      const { username, password } = await request.json();
      let stmt = env.DB.prepare('SELECT password FROM admin_credentials WHERE username = ?');
      let result = await stmt.bind(username).first();

      let storedPassword = null;
      if (result) {
        storedPassword = result.password;
      } else if (username === 'admin') {
        const defaultPassword = 'admin';
        try {
          await env.DB.prepare('INSERT OR IGNORE INTO admin_credentials (username, password) VALUES (?, ?)')
                      .bind('admin', defaultPassword)
                      .run();
          storedPassword = defaultPassword;
        } catch (dbError) {
           if (dbError.message.includes('no such table')) {
             await env.DB.exec(D1_SCHEMAS.admin_credentials);
             storedPassword = defaultPassword;
           } else {
             throw dbError;
           }
        }
      }

      if (storedPassword && password === storedPassword) {
        const token = btoa(username + ':' + Date.now());
        return new Response(JSON.stringify({ token }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({ error: 'Invalid credentials', message: '用户名或密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Login error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理登录状态检查
  if (path === '/api/auth/status' && method === 'GET') {
    const authHeader = request.headers.get('Authorization');
    const authenticated = authHeader && authHeader.startsWith('Bearer ');
    return new Response(JSON.stringify({ authenticated }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
  
  // 处理获取服务器列表 (Public)
  if (path === '/api/servers' && method === 'GET') {
    try {
      const stmt = env.DB.prepare('SELECT id, name, description FROM servers ORDER BY sort_order ASC NULLS LAST, name ASC');
      const { results } = await stmt.all();
      return new Response(JSON.stringify({ servers: results || [] }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
       console.error("Get servers error:", error);
       if (error.message.includes('no such table')) {
         try {
           await env.DB.exec(D1_SCHEMAS.servers);
           return new Response(JSON.stringify({ servers: [] }), {
             headers: { 'Content-Type': 'application/json', ...corsHeaders }
           });
         } catch (createError) {
            return new Response(JSON.stringify({ error: 'Database error', message: createError.message }), {
              status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
         }
       }
       return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
         status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
       });
    }
  }
  
  // 处理获取服务器状态 (Public)
  if (path.startsWith('/api/status/') && method === 'GET') {
    try {
      const serverId = path.split('/').pop();
      const serverStmt = env.DB.prepare('SELECT id, name, description FROM servers WHERE id = ?');
      const serverData = await serverStmt.bind(serverId).first();

      if (!serverData) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 获取 ping 字段
      const metricsStmt = env.DB.prepare('SELECT timestamp, cpu, memory, disk, network, uptime, ping FROM metrics WHERE server_id = ?');
      const metricsResult = await metricsStmt.bind(serverId).first();

      let metricsData = null;
      if (metricsResult) {
         try {
            metricsData = {
                timestamp: metricsResult.timestamp,
                cpu: JSON.parse(metricsResult.cpu || '{}'),
                memory: JSON.parse(metricsResult.memory || '{}'),
                disk: JSON.parse(metricsResult.disk || '{}'),
                network: JSON.parse(metricsResult.network || '{}'),
                ping: JSON.parse(metricsResult.ping || '{}'), // 解析 Ping
                uptime: metricsResult.uptime
            };
         } catch (parseError) {
             console.error(`Error parsing metrics JSON for server ${serverId}:`, parseError);
             metricsData = { timestamp: metricsResult.timestamp, uptime: metricsResult.uptime };
         }
      }

      const responseData = {
        server: serverData,
        metrics: metricsData
      };
      return new Response(JSON.stringify(responseData), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Get status error:", error);
      if (error.message.includes('no such table')) {
         try {
           await env.DB.exec(D1_SCHEMAS.servers + D1_SCHEMAS.metrics);
            return new Response(JSON.stringify({ error: 'Server not found (tables created)' }), {
              status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
         } catch (createError) {}
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理管理API - 获取所有服务器
  if (path === '/api/admin/servers' && method === 'GET') {
    try {
      const stmt = env.DB.prepare(`
        SELECT 
          s.id, s.name, s.description, s.created_at, s.sort_order,
          s.last_notified_down_at,
          m.timestamp as last_report
        FROM servers s
        LEFT JOIN metrics m ON s.id = m.server_id
        ORDER BY s.sort_order ASC NULLS LAST, s.name ASC
      `);
      const { results } = await stmt.all();

      return new Response(JSON.stringify({ servers: results || [] }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin get servers error:", error);
      if (error.message.includes('no such table')) {
         try {
           await env.DB.exec(D1_SCHEMAS.servers + D1_SCHEMAS.metrics);
           return new Response(JSON.stringify({ servers: [] }), {
             headers: { 'Content-Type': 'application/json', ...corsHeaders }
           });
         } catch (createError) {}
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理管理API - 添加新服务器
  if (path === '/api/admin/servers' && method === 'POST') {
    try {
      const { name, description } = await request.json();

      if (!name) {
        return new Response(JSON.stringify({ error: 'Server name is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const serverId = Math.random().toString(36).substring(2, 10);
      const apiKey = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      const createdAt = Math.floor(Date.now() / 1000);

      const maxOrderStmt = env.DB.prepare('SELECT MAX(sort_order) as max_order FROM servers');
      const maxOrderResult = await maxOrderStmt.first();
      const nextSortOrder = (maxOrderResult && typeof maxOrderResult.max_order === 'number') ? maxOrderResult.max_order + 1 : 0;

      const stmt = env.DB.prepare(
        'INSERT INTO servers (id, name, description, api_key, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      );
      await stmt.bind(serverId, name, description || '', apiKey, createdAt, nextSortOrder).run();

      const serverData = {
        id: serverId,
        name,
        description: description || '',
        api_key: apiKey,
        created_at: createdAt,
        sort_order: nextSortOrder
      };
      return new Response(JSON.stringify({ server: serverData }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin add server error:", error);
      if (error.message.includes('UNIQUE constraint failed')) {
         return new Response(JSON.stringify({ error: 'Server ID or API Key conflict', message: '服务器ID或API密钥冲突，请重试' }), {
           status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders }
         });
      }
      if (error.message.includes('no such table')) {
         try {
           await env.DB.exec(D1_SCHEMAS.servers);
            return new Response(JSON.stringify({ error: 'Database table created, please retry', message: '数据库表已创建，请重试添加操作' }), {
              status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
         } catch (createError) {}
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理管理API - 删除服务器
  if (path.match(/\/api\/admin\/servers\/[^\/]+$/) && method === 'DELETE') {
    try {
      const serverId = path.split('/').pop();
      const stmt = env.DB.prepare('DELETE FROM servers WHERE id = ?');
      const info = await stmt.bind(serverId).run();

      if (info.changes === 0) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin delete server error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理管理API - 更新服务器
  if (path.match(/\/api\/admin\/servers\/[^\/]+$/) && method === 'PUT') {
    try {
      const serverId = path.split('/').pop();
      const { name, description } = await request.json();

      if (!name) {
        return new Response(JSON.stringify({ error: 'Server name is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      let setClauses = [];
      let bindings = [];

      if (name !== undefined) {
        setClauses.push("name = ?");
        bindings.push(name);
      }
      if (description !== undefined) {
        setClauses.push("description = ?");
        bindings.push(description || '');
      }

      if (setClauses.length === 0) {
        return new Response(JSON.stringify({ error: 'No fields to update provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      bindings.push(serverId);

      const stmt = env.DB.prepare(
        `UPDATE servers SET ${setClauses.join(', ')} WHERE id = ?`
      );
      const info = await stmt.bind(...bindings).run();

      if (info.changes === 0) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin update server error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理数据上报API
  if (path.startsWith('/api/report/') && method === 'POST') {
    try {
      const serverId = path.split('/').pop();
      const apiKey = request.headers.get('X-API-Key');

      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'API key required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const serverStmt = env.DB.prepare('SELECT api_key FROM servers WHERE id = ?');
      const serverData = await serverStmt.bind(serverId).first();

      if (!serverData) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      if (serverData.api_key !== apiKey) {
        return new Response(JSON.stringify({ error: 'Invalid API key' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const reportData = await request.json();
      if (!reportData.timestamp || !reportData.cpu || !reportData.memory || !reportData.disk || !reportData.network || typeof reportData.uptime === 'undefined') {
        return new Response(JSON.stringify({ error: 'Invalid data format, missing required fields including uptime' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 保存监控数据到D1 (包含 ping)
      const metricsStmt = env.DB.prepare(`
        REPLACE INTO metrics (server_id, timestamp, cpu, memory, disk, network, uptime, ping) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      await metricsStmt.bind(
        serverId,
        reportData.timestamp,
        JSON.stringify(reportData.cpu),
        JSON.stringify(reportData.memory),
        JSON.stringify(reportData.disk),
        JSON.stringify(reportData.network),
        reportData.uptime,
        JSON.stringify(reportData.ping || {}) // 存储 ping 数据
      ).run();
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Report API error:", error);
       if (error.message.includes('no such table')) {
         try {
           await env.DB.exec(D1_SCHEMAS.servers + D1_SCHEMAS.metrics);
            return new Response(JSON.stringify({ error: 'Database table created or server not found, please retry or verify server ID/API Key', message: '数据库表已创建或服务器不存在，请重试或验证服务器ID/API密钥' }), {
              status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
         } catch (createError) {}
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理管理API - 获取服务器的API密钥
  if (path.match(/\/api\/admin\/servers\/[^\/]+\/key$/) && method === 'GET') {
    try {
      const serverId = path.split('/')[4];
      const stmt = env.DB.prepare('SELECT api_key FROM servers WHERE id = ?');
      const result = await stmt.bind(serverId).first();

      if (!result) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({ api_key: result.api_key }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin get API key error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // 处理管理API - 服务器排序
  if (path.match(/\/api\/admin\/servers\/[^\/]+\/reorder$/) && method === 'POST') {
    try {
      const serverId = path.split('/')[4];
      const { direction } = await request.json();

      if (!direction || (direction !== 'up' && direction !== 'down')) {
        return new Response(JSON.stringify({ error: 'Invalid direction' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const results = await env.DB.batch([
        env.DB.prepare('SELECT id, sort_order FROM servers ORDER BY sort_order ASC NULLS LAST, name ASC')
      ]);
      const allServers = results[0].results;
      const currentIndex = allServers.findIndex(s => s.id === serverId);
      if (currentIndex === -1) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      let targetIndex = -1;
      if (direction === 'up' && currentIndex > 0) {
        targetIndex = currentIndex - 1;
      } else if (direction === 'down' && currentIndex < allServers.length - 1) {
        targetIndex = currentIndex + 1;
      }

      if (targetIndex !== -1) {
        const currentServer = allServers[currentIndex];
        const targetServer = allServers[targetIndex];

        let currentOrder = currentServer.sort_order;
        let targetOrder = targetServer.sort_order;

        if (currentOrder === null || targetOrder === null) {
           console.warn("Reordering with NULL sort_order, re-assigning all orders.");
           const updateStmts = allServers.map((server, index) =>
             env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(index, server.id)
           );
           await env.DB.batch(updateStmts);
           const updatedResults = await env.DB.batch([
              env.DB.prepare('SELECT id, sort_order FROM servers ORDER BY sort_order ASC')
           ]);
           const updatedServers = updatedResults[0].results;
           const newCurrentIndex = updatedServers.findIndex(s => s.id === serverId);
           let newTargetIndex = -1;
           if (direction === 'up' && newCurrentIndex > 0) newTargetIndex = newCurrentIndex - 1;
           else if (direction === 'down' && newCurrentIndex < updatedServers.length - 1) newTargetIndex = newCurrentIndex + 1;
           if (newTargetIndex !== -1) {
              currentOrder = updatedServers[newCurrentIndex].sort_order;
              targetOrder = updatedServers[newTargetIndex].sort_order;
              await env.DB.batch([
                env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(targetOrder, serverId),
                env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(currentOrder, updatedServers[newTargetIndex].id)
              ]);
           }
        } else {
          await env.DB.batch([
            env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(targetOrder, serverId),
            env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(currentOrder, targetServer.id)
          ]);
        }
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin reorder server error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // 处理密码修改API
  if (path === '/api/auth/change-password' && method === 'POST') {
    try {
      const adminUsername = 'admin';
      const { current_password, new_password } = await request.json();

      if (!current_password || !new_password) {
        return new Response(JSON.stringify({ error: 'Current password and new password are required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      let stmt = env.DB.prepare('SELECT password FROM admin_credentials WHERE username = ?');
      let result = await stmt.bind(adminUsername).first();

      if (!result) {
         return new Response(JSON.stringify({ error: 'Admin user not found', message: '管理员用户不存在' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      if (result.password !== current_password) {
        return new Response(JSON.stringify({ error: 'Current password is incorrect', message: '当前密码不正确' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      stmt = env.DB.prepare('UPDATE admin_credentials SET password = ? WHERE username = ?');
      await stmt.bind(new_password, adminUsername).run();

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Change password error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // --- Website Monitoring API ---

  // 处理管理API - 获取监控站点列表
  if (path === '/api/admin/sites' && method === 'GET') {
    try {
      const stmt = env.DB.prepare('SELECT id, name, url, added_at, last_checked, last_status, last_status_code, last_response_time_ms, sort_order, last_notified_down_at FROM monitored_sites ORDER BY sort_order ASC NULLS LAST, name ASC, url ASC');
      const { results } = await stmt.all();
      return new Response(JSON.stringify({ sites: results || [] }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin get sites error:", error);
      if (error.message.includes('no such table')) {
         try {
           await env.DB.exec(D1_SCHEMAS.monitored_sites);
           return new Response(JSON.stringify({ sites: [] }), {
             headers: { 'Content-Type': 'application/json', ...corsHeaders }
           });
         } catch (createError) {}
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // 处理管理API - 添加监控站点
  if (path === '/api/admin/sites' && method === 'POST') {
    try {
      const { url, name } = await request.json();

      if (!url || !isValidHttpUrl(url)) {
        return new Response(JSON.stringify({ error: 'Valid URL is required', message: '请输入有效的URL' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const siteId = Math.random().toString(36).substring(2, 12);
      const addedAt = Math.floor(Date.now() / 1000);
      const maxOrderStmt = env.DB.prepare('SELECT MAX(sort_order) as max_order FROM monitored_sites');
      const maxOrderResult = await maxOrderStmt.first();
      const nextSortOrder = (maxOrderResult && typeof maxOrderResult.max_order === 'number') ? maxOrderResult.max_order + 1 : 0;

      const stmt = env.DB.prepare(
        'INSERT INTO monitored_sites (id, url, name, added_at, last_status, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      );
      await stmt.bind(siteId, url, name || '', addedAt, 'PENDING', nextSortOrder).run();

      const siteData = {
        id: siteId,
        url,
        name: name || '',
        added_at: addedAt,
        last_status: 'PENDING',
        sort_order: nextSortOrder
      };
      
      const newSiteForCheck = {
        id: siteId,
        url: url,
        name: name || ''
      };
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(checkWebsiteStatus(newSiteForCheck, env.DB, ctx));
        console.log(`Scheduled immediate health check for new site: ${siteId} (${url})`);
      } else {
        checkWebsiteStatus(newSiteForCheck, env.DB, ctx).catch(e => console.error("Error during direct immediate site check:", e));
      }

      return new Response(JSON.stringify({ site: siteData }), {
        status: 201, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin add site error:", error);
      if (error.message.includes('UNIQUE constraint failed')) {
         return new Response(JSON.stringify({ error: 'URL already exists or ID conflict', message: '该URL已被监控或ID冲突' }), {
           status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders }
         });
      }
      if (error.message.includes('no such table')) {
         try {
           await env.DB.exec(D1_SCHEMAS.monitored_sites);
            return new Response(JSON.stringify({ error: 'Database table created, please retry', message: '数据库表已创建，请重试添加操作' }), {
              status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
         } catch (createError) {}
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // 处理管理API - 更新监控站点
  if (path.match(/\/api\/admin\/sites\/[^\/]+$/) && method === 'PUT') {
    try {
      const siteId = path.split('/').pop();
      const { url, name } = await request.json();

      let setClauses = [];
      let bindings = [];

      if (url !== undefined) {
        if (!isValidHttpUrl(url)) {
          return new Response(JSON.stringify({ error: 'Valid URL is required if provided' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        setClauses.push("url = ?");
        bindings.push(url);
      }
      if (name !== undefined) {
        setClauses.push("name = ?");
        bindings.push(name || '');
      }
      
      if (setClauses.length === 0) {
        return new Response(JSON.stringify({ error: 'No fields to update provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      bindings.push(siteId);

      const stmt = env.DB.prepare(
        `UPDATE monitored_sites SET ${setClauses.join(', ')} WHERE id = ?`
      );
      const info = await stmt.bind(...bindings).run();

      if (info.changes === 0) {
        return new Response(JSON.stringify({ error: 'Site not found or no changes made' }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      const updatedSiteStmt = env.DB.prepare('SELECT id, url, name, added_at, last_checked, last_status, last_status_code, last_response_time_ms, sort_order FROM monitored_sites WHERE id = ?');
      const updatedSite = await updatedSiteStmt.bind(siteId).first();

      return new Response(JSON.stringify({ site: updatedSite }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin update site error:", error);
      if (error.message.includes('UNIQUE constraint failed')) {
         return new Response(JSON.stringify({ error: 'URL already exists for another site', message: '该URL已被其他监控站点使用' }), {
           status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders }
         });
      }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // 处理管理API - 删除监控站点
  if (path.match(/\/api\/admin\/sites\/[^\/]+$/) && method === 'DELETE') {
    try {
      const siteId = path.split('/').pop();
      const stmt = env.DB.prepare('DELETE FROM monitored_sites WHERE id = ?');
      const info = await stmt.bind(siteId).run();
      if (info.changes === 0) {
        return new Response(JSON.stringify({ error: 'Site not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin delete site error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // 处理管理API - 网站排序
  if (path.match(/\/api\/admin\/sites\/[^\/]+\/reorder$/) && method === 'POST') {
    try {
      const siteId = path.split('/')[4];
      const { direction } = await request.json();

      if (!direction || (direction !== 'up' && direction !== 'down')) {
        return new Response(JSON.stringify({ error: 'Invalid direction' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const results = await env.DB.batch([
        env.DB.prepare('SELECT id, sort_order FROM monitored_sites ORDER BY sort_order ASC NULLS LAST, name ASC, url ASC')
      ]);
      const allSites = results[0].results;
      const currentIndex = allSites.findIndex(s => s.id === siteId);
      if (currentIndex === -1) {
        return new Response(JSON.stringify({ error: 'Site not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      let targetIndex = -1;
      if (direction === 'up' && currentIndex > 0) {
        targetIndex = currentIndex - 1;
      } else if (direction === 'down' && currentIndex < allSites.length - 1) {
        targetIndex = currentIndex + 1;
      }

      if (targetIndex !== -1) {
        const currentSite = allSites[currentIndex];
        const targetSite = allSites[targetIndex];

        if (currentSite.sort_order === null || targetSite.sort_order === null) {
           console.warn("Reordering sites with NULL sort_order, re-assigning all orders.");
           const updateStmts = allSites.map((site, index) =>
             env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(index, site.id)
           );
           await env.DB.batch(updateStmts);
           const updatedResults = await env.DB.batch([
              env.DB.prepare('SELECT id, sort_order FROM monitored_sites ORDER BY sort_order ASC')
           ]);
           const updatedSites = updatedResults[0].results;
           const newCurrentIndex = updatedSites.findIndex(s => s.id === siteId);
           let newTargetIndex = -1;
           if (direction === 'up' && newCurrentIndex > 0) newTargetIndex = newCurrentIndex - 1;
           else if (direction === 'down' && newCurrentIndex < updatedSites.length - 1) newTargetIndex = newCurrentIndex + 1;
           if (newTargetIndex !== -1) {
              const currentOrder = updatedSites[newCurrentIndex].sort_order;
              const targetOrder = updatedSites[newTargetIndex].sort_order;
              await env.DB.batch([
                env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(targetOrder, siteId),
                env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(currentOrder, updatedSites[newTargetIndex].id)
              ]);
           }
        } else {
          await env.DB.batch([
            env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(targetSite.sort_order, siteId),
            env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(currentSite.sort_order, targetSite.id)
          ]);
        }
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin reorder site error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }


  // 处理公共API - 获取所有监控站点状态 (URL removed)
  if (path === '/api/sites/status' && method === 'GET') {
     try {
      const stmt = env.DB.prepare('SELECT id, name, last_checked, last_status, last_status_code, last_response_time_ms FROM monitored_sites ORDER BY sort_order ASC NULLS LAST, name ASC, id ASC');
      const { results } = await stmt.all();
      return new Response(JSON.stringify({ sites: results || [] }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Get sites status error:", error);
      if (error.message.includes('no such table')) {
         try {
           await env.DB.exec(D1_SCHEMAS.monitored_sites);
           return new Response(JSON.stringify({ sites: [] }), {
             headers: { 'Content-Type': 'application/json', ...corsHeaders }
           });
         } catch (createError) {}
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // --- End Website Monitoring API ---

  // --- App Config Settings API (for VPS report interval) ---
  // GET /api/admin/settings/vps-report-interval
  if (path === '/api/admin/settings/vps-report-interval' && method === 'GET') {
    try {
      const stmt = env.DB.prepare('SELECT value FROM app_config WHERE key = ?');
      const result = await stmt.bind('vps_report_interval_seconds').first();
      const interval = result ? parseInt(result.value, 10) : 60;

      return new Response(JSON.stringify({ interval: interval }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Get VPS report interval error:", error);
      if (error.message.includes('no such table')) {
        try {
          await env.DB.exec(D1_SCHEMAS.app_config);
          return new Response(JSON.stringify({ interval: 60 }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (createError) {}
      }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // POST /api/admin/settings/vps-report-interval
  if (path === '/api/admin/settings/vps-report-interval' && method === 'POST') {
    try {
      const { interval } = await request.json();
      if (typeof interval !== 'number' || interval <= 0 || !Number.isInteger(interval)) {
        return new Response(JSON.stringify({ error: 'Invalid interval value. Must be a positive integer (seconds).' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const stmt = env.DB.prepare('REPLACE INTO app_config (key, value) VALUES (?, ?)');
      await stmt.bind('vps_report_interval_seconds', interval.toString()).run();
      return new Response(JSON.stringify({ success: true, interval: interval }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Update VPS report interval error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  // --- End App Config Settings API ---


  // --- Telegram Settings API ---
  if (path === '/api/admin/telegram-settings' && method === 'GET') {
    try {
      const stmt = env.DB.prepare('SELECT bot_token, chat_id, enable_notifications FROM telegram_config WHERE id = 1');
      const settings = await stmt.first();
      return new Response(JSON.stringify(settings || { bot_token: null, chat_id: null, enable_notifications: 0 }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Get Telegram settings error:", error);
      if (error.message.includes('no such table')) {
        try {
          await env.DB.exec(D1_SCHEMAS.telegram_config);
          return new Response(JSON.stringify({ bot_token: null, chat_id: null, enable_notifications: 0 }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (createError) {}
      }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  if (path === '/api/admin/telegram-settings' && method === 'POST') {
    try {
      const { bot_token, chat_id, enable_notifications } = await request.json();
      const updatedAt = Math.floor(Date.now() / 1000);

      const enableNotifValue = (enable_notifications === true || enable_notifications === 1) ? 1 : 0;

      const stmt = env.DB.prepare(
        'UPDATE telegram_config SET bot_token = ?, chat_id = ?, enable_notifications = ?, updated_at = ? WHERE id = 1'
      );
      await stmt.bind(bot_token || null, chat_id || null, enableNotifValue, updatedAt).run();
      
      if (enableNotifValue === 1 && bot_token && chat_id) {
        const testMessage = "✅ Telegram 通知已在此监控面板激活。这是一条测试消息。";
        if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(sendTelegramNotification(env.DB, testMessage));
        } else {
            sendTelegramNotification(env.DB, testMessage).catch(e => console.error("Error sending test notification (direct call):", e));
        }
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Update Telegram settings error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  // --- End Telegram Settings API ---

  // 处理公共API - 获取特定监控站点的24小时历史状态
  if (path.match(/\/api\/sites\/[^\/]+\/history$/) && method === 'GET') {
    try {
      const siteId = path.split('/')[3];
      const nowSeconds = Math.floor(Date.now() / 1000);
      const twentyFourHoursAgoSeconds = nowSeconds - (24 * 60 * 60);
      const stmt = env.DB.prepare(
        'SELECT timestamp, status, status_code, response_time_ms FROM site_status_history WHERE site_id = ? AND timestamp >= ? ORDER BY timestamp DESC'
      );
      const { results } = await stmt.bind(siteId, twentyFourHoursAgoSeconds).all();

      return new Response(JSON.stringify({ history: results || [] }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Get site history error:", error);
      if (error.message.includes('no such table')) {
         try {
           await env.DB.exec(D1_SCHEMAS.site_status_history);
           return new Response(JSON.stringify({ history: [] }), {
             headers: { 'Content-Type': 'application/json', ...corsHeaders }
           });
         } catch (createError) {}
      }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }


  // 未找到匹配的API路由
  return new Response(JSON.stringify({ error: 'API endpoint not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}


// --- Scheduled Task for Website Monitoring ---

// Helper function to send Telegram notification
async function sendTelegramNotification(db, message) {
  try {
    const configStmt = db.prepare('SELECT bot_token, chat_id, enable_notifications FROM telegram_config WHERE id = 1');
    const config = await configStmt.first();

    if (!config || !config.enable_notifications || !config.bot_token || !config.chat_id) {
      console.log("Telegram notifications are disabled or not configured.");
      return;
    }

    const telegramApiUrl = `https://api.telegram.org/bot${config.bot_token}/sendMessage`;
    const response = await fetch(telegramApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chat_id,
        text: message,
        parse_mode: 'Markdown'
      })
    });
    if (!response.ok) {
      const errorData = await response.json();
      console.error(`Failed to send Telegram notification: ${response.status}`, errorData);
    } else {
      console.log("Telegram notification sent successfully.");
    }
  } catch (error) {
    console.error("Error sending Telegram notification:", error);
  }
}


async function checkWebsiteStatus(site, db, ctx) {
  const { id, url, name } = site;
  const startTime = Date.now();
  let newStatus = 'PENDING';
  let newStatusCode = null;
  let newResponseTime = null;
  let previousStatus = 'PENDING';
  let siteLastNotifiedDownAt = null;

  try {
    const siteDetailsStmt = db.prepare('SELECT last_status, last_notified_down_at FROM monitored_sites WHERE id = ?');
    const siteDetailsResult = await siteDetailsStmt.bind(id).first();
    if (siteDetailsResult) {
      previousStatus = siteDetailsResult.last_status || 'PENDING';
      siteLastNotifiedDownAt = siteDetailsResult.last_notified_down_at;
    }
  } catch (e) {
    console.error(`获取网站 ${id} 详情错误:`, e);
  }
  const NOTIFICATION_INTERVAL_SECONDS = 1 * 60 * 60; // 1 hour


  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) });
    newResponseTime = Date.now() - startTime;
    newStatusCode = response.status;

    if (response.ok || (response.status >= 300 && response.status < 500)) { // 2xx, 3xx, and 4xx are considered UP
      newStatus = 'UP';
    } else {
      newStatus = 'DOWN';
    }
  } catch (error) {
    newResponseTime = Date.now() - startTime;
    if (error.name === 'TimeoutError') {
      newStatus = 'TIMEOUT';
    } else {
      newStatus = 'ERROR';
      console.error(`检查网站 ${id} (${url}) 错误:`, error.message);
    }
  }

  const checkTime = Math.floor(Date.now() / 1000);
  const siteDisplayName = name || url;
  let newSiteLastNotifiedDownAt = siteLastNotifiedDownAt;

  if (['DOWN', 'TIMEOUT', 'ERROR'].includes(newStatus)) {
    const isFirstTimeDown = !['DOWN', 'TIMEOUT', 'ERROR'].includes(previousStatus);
    if (isFirstTimeDown) {
      const message = `🔴 网站故障: *${siteDisplayName}* 当前状态 ${newStatus.toLowerCase()} (状态码: ${newStatusCode || '无'}).\n网址: ${url}`;
      ctx.waitUntil(sendTelegramNotification(db, message));
      newSiteLastNotifiedDownAt = checkTime;
      console.log(`网站 ${siteDisplayName} 刚刚故障。已发送初始通知。last_notified_down_at 已更新。`);
    } else {
      const shouldResend = siteLastNotifiedDownAt === null || (checkTime - siteLastNotifiedDownAt > NOTIFICATION_INTERVAL_SECONDS);
      if (shouldResend) {
        const message = `🔴 网站持续故障: *${siteDisplayName}* 状态 ${newStatus.toLowerCase()} (状态码: ${newStatusCode || '无'}).\n网址: ${url}`;
        ctx.waitUntil(sendTelegramNotification(db, message));
        newSiteLastNotifiedDownAt = checkTime;
        console.log(`网站 ${siteDisplayName} 持续故障。已发送重复通知。last_notified_down_at 已更新。`);
      } else {
        console.log(`网站 ${siteDisplayName} 持续故障，但1小时通知间隔未到。`);
      }
    }
  } else if (newStatus === 'UP' && ['DOWN', 'TIMEOUT', 'ERROR'].includes(previousStatus)) {
    const message = `✅ 网站恢复: *${siteDisplayName}* 已恢复在线!\n网址: ${url}`;
    ctx.waitUntil(sendTelegramNotification(db, message));
    newSiteLastNotifiedDownAt = null; 
    console.log(`网站 ${siteDisplayName} 已恢复。已发送通知。last_notified_down_at 已清除。`);
  }

  // Update D1
  try {
    const updateSiteStmt = db.prepare(
      'UPDATE monitored_sites SET last_checked = ?, last_status = ?, last_status_code = ?, last_response_time_ms = ?, last_notified_down_at = ? WHERE id = ?'
    );
    const recordHistoryStmt = db.prepare(
      'INSERT INTO site_status_history (site_id, timestamp, status, status_code, response_time_ms) VALUES (?, ?, ?, ?, ?)'
    );
    await db.batch([
      updateSiteStmt.bind(checkTime, newStatus, newStatusCode, newResponseTime, newSiteLastNotifiedDownAt, id),
      recordHistoryStmt.bind(id, checkTime, newStatus, newStatusCode, newResponseTime)
    ]);
    console.log(`已检查网站 ${id} (${url}): ${newStatus} (${newStatusCode || '无'}), ${newResponseTime}ms。历史已记录。通知时间戳已更新。`);
  } catch (dbError) {
    console.error(`更新网站 ${id} (${url}) 状态或记录历史到D1失败:`, dbError);
  }
}

// Combine fetch and scheduled handlers into a single default export
export default {
  async fetch(request, env, ctx) {
    ctx.waitUntil(ensureTablesExist(env.DB));
    const url = new URL(request.url);
    const path = url.pathname;

    // API requests
    if (path.startsWith('/api/')) {
      return handleApiRequest(request, env, ctx);
    }

    // Install script
    if (path === '/install.sh') {
      return handleInstallScript(request, url, env);
    }

    // Frontend static files
    return handleFrontendRequest(request, path);
  },

  async scheduled(event, env, ctx) {
    console.log(`Cron Trigger: ${event.cron} - Running website status checks...`);
    ctx.waitUntil(
      (async () => {
        try {
      await ensureTablesExist(env.DB);

      // --- Part 1: Website Monitoring ---
      console.log("Starting scheduled website checks...");
      const siteStmt = env.DB.prepare('SELECT id, url, name FROM monitored_sites');
      const { results: sitesToCheck } = await siteStmt.all();

      if (sitesToCheck && sitesToCheck.length > 0) {
        console.log(`Found ${sitesToCheck.length} sites to check.`);
        const sitePromises = [];
        const siteConcurrencyLimit = 10;
        for (const site of sitesToCheck) {
          sitePromises.push(checkWebsiteStatus(site, env.DB, ctx));
          if (sitePromises.length >= siteConcurrencyLimit) {
            await Promise.all(sitePromises);
            sitePromises.length = 0;
          }
        }
        if (sitePromises.length > 0) {
          await Promise.all(sitePromises);
        }
        console.log("Website status checks completed.");
      } else {
        console.log("No sites configured for monitoring.");
      }

      // --- Part 2: VPS Monitoring & Notifications ---
      console.log("开始计划的VPS状态检查以发送通知...");
      const serverConfigStmt = env.DB.prepare('SELECT bot_token, chat_id, enable_notifications FROM telegram_config WHERE id = 1');
      const telegramConfig = await serverConfigStmt.first();
      if (!telegramConfig || !telegramConfig.enable_notifications || !telegramConfig.bot_token || !telegramConfig.chat_id) {
        console.log("VPS的Telegram通知已禁用或未配置。跳过VPS检查。");
        return;
      }
      
      const serverStmt = env.DB.prepare(`
        SELECT s.id, s.name, s.last_notified_down_at, m.timestamp as last_report
        FROM servers s
        LEFT JOIN metrics m ON s.id = m.server_id
      `);
      const { results: serversToCheck } = await serverStmt.all();
      if (!serversToCheck || serversToCheck.length === 0) {
        console.log("未找到用于VPS状态检查的服务器。");
        return;
      }

      console.log(`找到 ${serversToCheck.length} 台服务器进行VPS状态检查。`);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const staleThresholdSeconds = 5 * 60; // 5 minutes
      const NOTIFICATION_INTERVAL_SECONDS = 1 * 60 * 60; // 1 hour

      for (const server of serversToCheck) {
        const isStale = !server.last_report || (nowSeconds - server.last_report > staleThresholdSeconds);
        const serverDisplayName = server.name || server.id;
        const lastReportTimeStr = server.last_report ? new Date(server.last_report * 1000).toLocaleString('zh-CN') : '从未';

        if (isStale) {
          const shouldSendNotification = server.last_notified_down_at === null || (nowSeconds - server.last_notified_down_at > NOTIFICATION_INTERVAL_SECONDS);
          if (shouldSendNotification) {
            const message = `🔴 VPS 故障: 服务器 *${serverDisplayName}* 似乎已离线。最后报告: ${lastReportTimeStr}.`;
            ctx.waitUntil(sendTelegramNotification(env.DB, message));
            const updateStmt = env.DB.prepare('UPDATE servers SET last_notified_down_at = ? WHERE id = ?');
            ctx.waitUntil(updateStmt.bind(nowSeconds, server.id).run());
            console.log(`VPS ${serverDisplayName} 状态陈旧。已发送通知。last_notified_down_at 已更新。`);
          } else {
            console.log(`VPS ${serverDisplayName} 状态陈旧，但1小时通知间隔未到。`);
          }
        } else {
          if (server.last_notified_down_at !== null) {
            const message = `✅ VPS 恢复: 服务器 *${serverDisplayName}* 已恢复在线并正在报告。当前报告: ${lastReportTimeStr}.`;
            ctx.waitUntil(sendTelegramNotification(env.DB, message));
            const updateStmt = env.DB.prepare('UPDATE servers SET last_notified_down_at = NULL WHERE id = ?');
            ctx.waitUntil(updateStmt.bind(server.id).run());
            console.log(`VPS ${serverDisplayName} 已恢复。已发送通知。last_notified_down_at 已清除。`);
          } else {
             console.log(`VPS ${serverDisplayName} 在线并正在报告。无需通知。`);
          }
        }
      }
      console.log("VPS状态检查以发送通知已完成。");
    } catch (error) {
      console.error("计划任务期间发生错误:", error);
    }
  })()
);
}
};
// --- Utility Functions ---

function isValidHttpUrl(string) {
  let url;
  try {
    url = new URL(string);
  } catch (_) {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}


// --- Original Handlers (Install Script, Frontend) ---

// 处理安装脚本
// 处理安装脚本
// 处理安装脚本
async function handleInstallScript(request, url, env) {
  const baseUrl = url.origin;
  let vpsReportInterval = '60';

  try {
    if (D1_SCHEMAS && D1_SCHEMAS.app_config) {
        await env.DB.exec(D1_SCHEMAS.app_config);
    }
    
    const stmt = env.DB.prepare('SELECT value FROM app_config WHERE key = ?');
    const result = await stmt.bind('vps_report_interval_seconds').first();
    if (result && result.value) {
      const parsedInterval = parseInt(result.value, 10);
      if (!isNaN(parsedInterval) && parsedInterval > 0) {
        vpsReportInterval = parsedInterval.toString();
      }
    }
  } catch (e) {
    console.error("Error fetching VPS report interval for install script:", e);
  }
  
  const script = `#!/bin/bash
# VPS监控脚本 - 安装程序

# 默认值
API_KEY=""
SERVER_ID=""
WORKER_URL="${baseUrl}"
INSTALL_DIR="/opt/vps-monitor"
SERVICE_NAME="vps-monitor"

# 解析参数
while [[ $# -gt 0 ]]; do
  case $1 in
    -k|--key)
      API_KEY="$2"
      shift 2
      ;;
    -s|--server)
      SERVER_ID="$2"
      shift 2
      ;;
    -u|--url)
      WORKER_URL="$2"
      shift 2
      ;;
    -d|--dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    *)
      echo "未知参数: $1"
      exit 1
      ;;
  esac
done

# 检查必要参数
if [ -z "$API_KEY" ] || [ -z "$SERVER_ID" ]; then
  echo "错误: API密钥和服务器ID是必需的"
  echo "用法: $0 -k API_KEY -s SERVER_ID [-u WORKER_URL] [-d INSTALL_DIR]"
  exit 1
fi

# 检查权限
if [ "$(id -u)" -ne 0 ]; then
  echo "错误: 此脚本需要root权限"
  exit 1
fi

echo "=== VPS监控脚本安装程序 ==="
echo "安装目录: $INSTALL_DIR"
echo "Worker URL: $WORKER_URL"

# 创建安装目录
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR" || exit 1

# ==========================================
# 1. 创建 Python TCPing 守护进程脚本
# ==========================================
cat > "$INSTALL_DIR/ping_daemon.py" << 'PYTHONEOF'
import socket
import time
import json
import threading
import sys
from collections import deque

# 配置目标
TARGETS = {
    "cu": "www.tynews.com.cn",
    "ct": "www.chinaccs.cn",
    "cm": "sx.10086.cn"
}
PORT = 80
HISTORY_LEN = 100
INTERVAL = 2  # 每次Ping的间隔(秒)
OUTPUT_FILE = "/tmp/vps_monitor_ping.json"

# 存储历史记录 (True=通, False=丢)
history = {
    "cu": deque(maxlen=HISTORY_LEN),
    "ct": deque(maxlen=HISTORY_LEN),
    "cm": deque(maxlen=HISTORY_LEN)
}

def tcp_ping(host, port):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1.5)
        start = time.time()
        s.connect((host, port))
        s.close()
        return True
    except:
        return False

def worker(carrier, host):
    while True:
        result = tcp_ping(host, PORT)
        history[carrier].append(result)
        time.sleep(INTERVAL)

def data_writer():
    while True:
        data = {}
        for carrier, q in history.items():
            if len(q) == 0:
                data[carrier] = 0
            else:
                # 计算丢包率 (失败次数 / 总次数 * 100)
                lost_count = list(q).count(False)
                loss_rate = int((lost_count / len(q)) * 100)
                data[carrier] = loss_rate
        
        try:
            with open(OUTPUT_FILE, 'w') as f:
                json.dump(data, f)
        except:
            pass
        time.sleep(5)

# 启动线程
for carrier, host in TARGETS.items():
    t = threading.Thread(target=worker, args=(carrier, host))
    t.daemon = True
    t.start()

# 启动写入线程
writer = threading.Thread(target=data_writer)
writer.daemon = True
writer.start()

# 保持主线程运行
while True:
    time.sleep(60)
PYTHONEOF

# ==========================================
# 2. 创建主监控脚本 monitor.sh
# ==========================================
cat > "$INSTALL_DIR/monitor.sh" << 'EOF'
#!/bin/bash

# 获取脚本所在目录，防止 Systemd 启动时路径错误
WORKDIR=$(dirname "$(readlink -f "$0")")
cd "$WORKDIR" || exit 1

# 配置
API_KEY="__API_KEY__"
SERVER_ID="__SERVER_ID__"
WORKER_URL="__WORKER_URL__"
INTERVAL=${vpsReportInterval}

# 确保 Python 守护进程在运行
check_ping_daemon() {
    if ! pgrep -f "ping_daemon.py" > /dev/null; then
        nohup python3 "$WORKDIR/ping_daemon.py" > /dev/null 2>&1 &
    fi
}

# 读取 Ping 数据
get_ping_data() {
    if [ -f "/tmp/vps_monitor_ping.json" ]; then
        cat "/tmp/vps_monitor_ping.json"
    else
        echo '{"cu":0,"ct":0,"cm":0}'
    fi
}

# 日志函数
log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"
}

# 获取正常运行时间 (uptime)
get_uptime() {
  cat /proc/uptime | awk '{print $1}' | cut -d. -f1
}

# 获取CPU使用率 (注意引号转义)
get_cpu_usage() {
  cpu_usage=$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk '{print 100 - $1}')
  cpu_load=$(cat /proc/loadavg | awk '{print $1","$2","$3}')
  echo "{\\"usage_percent\\":$cpu_usage,\\"load_avg\\":[$cpu_load]}"
}

# 获取内存使用情况
get_memory_usage() {
  total=$(free -k | grep Mem | awk '{print $2}')
  used=$(free -k | grep Mem | awk '{print $3}')
  free=$(free -k | grep Mem | awk '{print $4}')
  usage_percent=$(echo "scale=1; $used * 100 / $total" | bc)
  echo "{\\"total\\":$total,\\"used\\":$used,\\"free\\":$free,\\"usage_percent\\":$usage_percent}"
}

# 获取硬盘使用情况
get_disk_usage() {
  disk_info=$(df -k / | tail -1)
  total=$(echo "$disk_info" | awk '{print $2 / 1024 / 1024}')
  used=$(echo "$disk_info" | awk '{print $3 / 1024 / 1024}')
  free=$(echo "$disk_info" | awk '{print $4 / 1024 / 1024}')
  usage_percent=$(echo "$disk_info" | awk '{print $5}' | tr -d '%')
  echo "{\\"total\\":$total,\\"used\\":$used,\\"free\\":$free,\\"usage_percent\\":$usage_percent}"
}

# 获取网络使用情况
get_network_usage() {
  # 检查是否安装了ifstat
  if ! command -v ifstat &> /dev/null; then
    log "ifstat未安装，无法获取网络速度"
    echo "{\\"upload_speed\\":0,\\"download_speed\\":0,\\"total_upload\\":0,\\"total_download\\":0}"
    return
  fi
  
  # 获取网络接口
  interface=$(ip route | grep default | awk '{print $5}')
  
  # 获取网络速度（KB/s）
  network_speed=$(ifstat -i "$interface" 1 1 | tail -1)
  download_speed=$(echo "$network_speed" | awk '{print $1 * 1024}')
  upload_speed=$(echo "$network_speed" | awk '{print $2 * 1024}')
  
  # 获取总流量
  rx_bytes=$(cat /proc/net/dev | grep "$interface" | awk '{print $2}')
  tx_bytes=$(cat /proc/net/dev | grep "$interface" | awk '{print $10}')
  
  echo "{\\"upload_speed\\":$upload_speed,\\"download_speed\\":$download_speed,\\"total_upload\\":$tx_bytes,\\"total_download\\":$rx_bytes}"
}

# 上报数据
report_metrics() {
  # 检查守护进程
  check_ping_daemon

  timestamp=$(date +%s)
  cpu=$(get_cpu_usage)
  memory=$(get_memory_usage)
  disk=$(get_disk_usage)
  network=$(get_network_usage)
  ping=$(get_ping_data)
  uptime=$(get_uptime)
  
  # 组装 JSON (关键：加入了 uptime，并保持双重转义 \\")
  data="{\\"timestamp\\":$timestamp,\\"cpu\\":$cpu,\\"memory\\":$memory,\\"disk\\":$disk,\\"network\\":$network,\\"ping\\":$ping,\\"uptime\\":$uptime}"
  
  # log "上报数据: $data"
  
  response=$(curl -s -X POST "$WORKER_URL/api/report/$SERVER_ID" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -d "$data")
  
  if [[ "$response" == *"success"* ]]; then
    log "数据上报成功"
  else
    log "数据上报失败: $response"
  fi
}

# 安装依赖
install_dependencies() {
  log "检查并安装依赖..."
  
  # 检测包管理器
  if command -v apt-get &> /dev/null; then
    PKG_MANAGER="apt-get"
  elif command -v yum &> /dev/null; then
    PKG_MANAGER="yum"
  else
    log "不支持的系统，无法自动安装依赖"
    return 1
  fi
  
  # 安装依赖 (增加 python3)
  $PKG_MANAGER update -y
  $PKG_MANAGER install -y bc curl ifstat python3
  
  log "依赖安装完成"
  return 0
}

# 主函数
main() {
  log "VPS监控脚本启动"
  
  # 安装依赖
  install_dependencies
  
  # 启动 Python 守护进程
  nohup python3 "$WORKDIR/ping_daemon.py" > /dev/null 2>&1 &
  
  # 主循环
  while true; do
    report_metrics
    sleep $INTERVAL
  done
}

# 启动主函数
main
EOF

# 替换配置
sed -i "s|__API_KEY__|$API_KEY|g" "$INSTALL_DIR/monitor.sh"
sed -i "s|__SERVER_ID__|$SERVER_ID|g" "$INSTALL_DIR/monitor.sh"
sed -i "s|__WORKER_URL__|$WORKER_URL|g" "$INSTALL_DIR/monitor.sh"
sed -i "s|^INTERVAL=.*|INTERVAL=${vpsReportInterval}|g" "$INSTALL_DIR/monitor.sh"
sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$INSTALL_DIR/monitor.sh"

# 设置执行权限
chmod +x "$INSTALL_DIR/monitor.sh"

# 创建systemd服务
cat > "/etc/systemd/system/$SERVICE_NAME.service" << EOF
[Unit]
Description=VPS Monitor Service
After=network.target

[Service]
ExecStart=$INSTALL_DIR/monitor.sh
Restart=always
User=root
Group=root
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF

# 启动服务
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"

echo "=== 安装完成 ==="
echo "服务已启动并设置为开机自启"
echo "查看服务状态: systemctl status $SERVICE_NAME"
echo "查看服务日志: journalctl -u $SERVICE_NAME -f"
`;
  return new Response(script, {
    headers: {
      'Content-Type': 'text/plain',
      'Content-Disposition': 'attachment; filename="install.sh"'
    }
  });
}

// 处理前端请求
function handleFrontendRequest(request, path) {
  // 默认页面
  if (path === '/' || path === '') {
    return new Response(getIndexHtml(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  // 登录页面
  if (path === '/login' || path === '/login.html') {
    return new Response(getLoginHtml(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  // 管理页面
  if (path === '/admin' || path === '/admin.html') {
    return new Response(getAdminHtml(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  // CSS文件
  if (path === '/css/style.css') {
    return new Response(getStyleCss(), {
      headers: { 'Content-Type': 'text/css' }
    });
  }
  
  // JavaScript文件
  if (path === '/js/main.js') {
    return new Response(getMainJs(), {
      headers: { 'Content-Type': 'application/javascript' }
    });
  }
  
  if (path === '/js/login.js') {
    return new Response(getLoginJs(), {
      headers: { 'Content-Type': 'application/javascript' }
    });
  }
  
  if (path === '/js/admin.js') {
    return new Response(getAdminJs(), {
      headers: { 'Content-Type': 'application/javascript' }
    });
  }
  
  // 404页面
  return new Response('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain' }
  });
}

// 前端HTML、CSS和JavaScript文件内容
function getIndexHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-bs-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Uptime Status</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.8.1/font/bootstrap-icons.css" rel="stylesheet">
    <link href="/css/style.css" rel="stylesheet">
    <style>
        .server-row { cursor: pointer; }
        .server-details-row td { padding: 1rem; background-color: #f8f9fa; }
        .server-details-content { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
        .detail-item { background-color: #e9ecef; padding: 0.75rem; border-radius: 0.25rem; }
        .detail-item strong { display: block; margin-bottom: 0.25rem; }
        .history-bar-container { display: inline-flex; flex-direction: row-reverse; align-items: center; justify-content: center; height: 25px; gap: 2px; }
        .history-bar { width: 8px; height: 100%; border-radius: 1px; }
        .history-bar-up { background-color: #28a745; } 
        .history-bar-down { background-color: #dc3545; } 
        .history-bar-pending { background-color: #6c757d; } 
        .progress span { color: #000000; }
        .table > thead > tr > th:nth-child(6), 
        #siteStatusTableBody tr > td:nth-child(6), 
        #serverTableBody tr > td:nth-child(6) { text-align: center; }

        /* Dark Theme Adjustments */
        [data-bs-theme="dark"] body { background-color: #212529 !important; color: #ffffff !important; }
        [data-bs-theme="dark"] h1, [data-bs-theme="dark"] h2, [data-bs-theme="dark"] h3, [data-bs-theme="dark"] h4, [data-bs-theme="dark"] h5, [data-bs-theme="dark"] h6 { color: #ffffff; }
        [data-bs-theme="dark"] a:not(.btn):not(.nav-link):not(.dropdown-item):not(.navbar-brand) { color: #87cefa; }
        [data-bs-theme="dark"] a:not(.btn):not(.nav-link):not(.dropdown-item):not(.navbar-brand):hover { color: #add8e6; }
        [data-bs-theme="dark"] .navbar-dark { background-color: #343a40 !important; }
        [data-bs-theme="dark"] .table { color: #ffffff; }
        [data-bs-theme="dark"] .table-striped > tbody > tr:nth-of-type(odd) > * { var(--bs-table-accent-bg): rgba(255, 255, 255, 0.05); color: #ffffff; }
        [data-bs-theme="dark"] .table-hover > tbody > tr:hover > * { var(--bs-table-accent-bg): rgba(255, 255, 255, 0.075); color: #ffffff; }
        [data-bs-theme="dark"] .server-details-row td { background-color: #343a40; border-top: 1px solid #495057; }
        [data-bs-theme="dark"] .detail-item { background-color: #495057; color: #ffffff; }
        [data-bs-theme="dark"] .progress { background-color: #495057; }
        [data-bs-theme="dark"] .progress span { color: #000000 !important; text-shadow: none; }
        [data-bs-theme="dark"] .footer.bg-light { background-color: #343a40 !important; border-top: 1px solid #495057; }
        [data-bs-theme="dark"] .footer .text-muted { color: #adb5bd !important; }
        [data-bs-theme="dark"] .alert-info { background-color: #17a2b8; color: #fff; border-color: #17a2b8; }
        [data-bs-theme="dark"] .btn-outline-light { color: #f8f9fa; border-color: #f8f9fa; }
        [data-bs-theme="dark"] .btn-outline-light:hover { color: #212529; background-color: #f8f9fa; }
        [data-bs-theme="dark"] .card { background-color: #343a40; border: 1px solid #495057; }
        [data-bs-theme="dark"] .card-header { background-color: #495057; border-bottom: 1px solid #5b6167; }
        [data-bs-theme="dark"] .modal-content { background-color: #343a40; color: #ffffff; }
        [data-bs-theme="dark"] .modal-header { border-bottom-color: #495057; }
        [data-bs-theme="dark"] .modal-footer { border-top-color: #495057; }
        [data-bs-theme="dark"] .form-control { background-color: #495057; color: #ffffff; border-color: #5b6167; }
        [data-bs-theme="dark"] .form-control:focus { background-color: #495057; color: #ffffff; border-color: #86b7fe; box-shadow: 0 0 0 0.25rem rgba(13, 110, 253, 0.25); }
        [data-bs-theme="dark"] .form-label { color: #adb5bd; }
        [data-bs-theme="dark"] .text-danger { color: #ff8888 !important; }
        [data-bs-theme="dark"] .text-muted { color: #adb5bd !important; }
        [data-bs-theme="dark"] span[style*="color: #000"] { color: #ffffff !important; }
    </style>
</head>
<body>
    <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container">
            <a class="navbar-brand" href="/">Uptime Status</a>
            <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
                <span class="navbar-toggler-icon"></span>
            </button>
            <div class="collapse navbar-collapse" id="navbarNav">
                <ul class="navbar-nav ms-auto align-items-center">
                    <li class="nav-item">
                        <button id="themeToggler" class="btn btn-outline-light btn-sm me-2" title="切换主题">
                             <i class="bi bi-moon-stars-fill"></i>
                        </button>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link" id="adminAuthLink" href="/login.html">管理员登录</a>
                    </li>
                </ul>
            </div>
        </div>
    </nav>

    <div class="container mt-4">
        <div id="noServers" class="alert alert-info d-none">
            暂无服务器数据，请先登录管理后台添加服务器。
        </div>

        <div class="table-responsive">
            <table class="table table-striped table-hover align-middle">
                <thead>
                    <tr>
                        <th>名称</th>
                        <th>状态</th>
                        <th>CPU</th>
                        <th>内存</th>
                        <th>硬盘</th>
                        <th class="text-center">线路 (CU|CT|CM)</th>
                        <th>上传</th>
                        <th>下载</th>
                        <th>总上传</th>
                        <th>总下载</th>
                        <th>运行时长</th>
                        <th>最后更新</th>
                    </tr>
                </thead>
                <tbody id="serverTableBody">
                    <tr>
                        <td colspan="12" class="text-center">加载中...</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <div class="container mt-5">
        <h2>网站在线状态</h2>
        <div id="noSites" class="alert alert-info d-none">
            暂无监控网站数据。
        </div>
        <div class="table-responsive">
            <table class="table table-striped table-hover align-middle">
                <thead>
                    <tr>
                        <th>名称</th>
                        <th>状态</th>
                        <th>状态码</th>
                        <th>响应时间 (ms)</th>
                        <th>最后检查</th>
                        <th>24h记录</th>
                    </tr>
                </thead>
                <tbody id="siteStatusTableBody">
                    <tr>
                        <td colspan="6" class="text-center">加载中...</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
    <template id="serverDetailsTemplate">
        <tr class="server-details-row d-none">
            <td colspan="12">
                <div class="server-details-content">
                    </div>
            </td>
        </tr>
    </template>

    <footer class="footer mt-5 py-3 bg-light">
        <div class="container text-center">
        <a href="https://rcrc.eu.org" target="_blank" rel="noopener noreferrer" class="ms-3 text-muted" title="Server Status">Server Status</a>
        </div>
    </footer>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
    <script src="/js/main.js"></script>
</body>
</html>`;
}

function getLoginHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-bs-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login - Uptime Status</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.8.1/font/bootstrap-icons.css" rel="stylesheet">
    <link href="/css/style.css" rel="stylesheet">
    <style>
       /* Same styles as index */
       /* Dark Theme Adjustments */
        [data-bs-theme="dark"] body { background-color: #212529; color: #ffffff; }
        [data-bs-theme="dark"] .card { background-color: #1e1e1e; border: 1px solid #333; color: #e0e0e0; }
        [data-bs-theme="dark"] .card-header { background-color: #2a2a2a; border-bottom: 1px solid #333; color: #f5f5f5; }
        [data-bs-theme="dark"] .form-control { background-color: #2a2a2a; color: #e0e0e0; border-color: #333; }
        [data-bs-theme="dark"] .footer.bg-light { background-color: #343a40 !important; border-top: 1px solid #495057; }
        [data-bs-theme="dark"] .footer .text-muted { color: #adb5bd !important; }
    </style>
</head>
<body>
    <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container">
            <a class="navbar-brand" href="/">Uptime Status</a>
            <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
                <span class="navbar-toggler-icon"></span>
            </button>
            <div class="collapse navbar-collapse" id="navbarNav">
                <ul class="navbar-nav ms-auto align-items-center">
                    <li class="nav-item">
                        <button id="themeToggler" class="btn btn-outline-light btn-sm me-2" title="切换主题">
                             <i class="bi bi-moon-stars-fill"></i>
                        </button>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link" href="/">返回首页</a>
                    </li>
                </ul>
            </div>
        </div>
    </nav>

    <div class="container mt-5">
        <div class="row justify-content-center">
            <div class="col-md-6 col-lg-4">
                <div class="card">
                    <div class="card-header">
                        <h4 class="card-title mb-0">管理员登录</h4>
                    </div>
                    <div class="card-body">
                        <div id="loginAlert" class="alert alert-danger d-none"></div>
                        <form id="loginForm">
                            <div class="mb-3">
                                <label for="username" class="form-label">用户名</label>
                                <input type="text" class="form-control" id="username" required>
                            </div>
                            <div class="mb-3">
                                <label for="password" class="form-label">密码</label>
                                <input type="password" class="form-control" id="password" required>
                            </div>
                            <div class="d-grid">
                                <button type="submit" class="btn btn-primary">登录</button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <footer class="footer mt-5 py-3 bg-light">
        <div class="container text-center">
            <span class="text-muted">&copy; Uptime Status</span>
        </div>
    </footer>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
    <script src="/js/login.js"></script>
</body>
</html>`;
}

function getAdminHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-bs-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Manage - Uptime Status</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.8.1/font/bootstrap-icons.css" rel="stylesheet">
    <link href="/css/style.css" rel="stylesheet">
</head>
<body>
    <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container">
            <a class="navbar-brand" href="/">Uptime Status</a>
            <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
                <span class="navbar-toggler-icon"></span>
            </button>
            <div class="collapse navbar-collapse" id="navbarNav">
                <ul class="navbar-nav me-auto">
                    <li class="nav-item">
                         <a class="nav-link" href="/">返回首页</a>
                    </li>
                </ul>
                <ul class="navbar-nav align-items-center">
                    <li class="nav-item">
                        <button id="themeToggler" class="btn btn-outline-light btn-sm me-2" title="切换主题">
                            <i class="bi bi-moon-stars-fill"></i>
                        </button>
                    </li>
                    <li class="nav-item">
                        <button id="changePasswordBtn" class="btn btn-outline-light btn-sm me-2">修改密码</button>
                    </li>
                    <li class="nav-item">
                        <button id="logoutBtn" class="btn btn-outline-light btn-sm">退出登录</button>
                    </li>
                </ul>
            </div>
        </div>
    </nav>

    <div class="container mt-4">
        <div class="d-flex align-items-center mb-4">
            <h2 class="mb-0 me-3">服务器管理</h2>
            <form id="globalSettingsFormPartial" class="row gx-2 gy-2 align-items-center me-auto">
                <div class="col-auto">
                     <label for="vpsReportInterval" class="col-form-label col-form-label-sm">VPS数据更新频率 (秒):</label>
                </div>
                <div class="col-auto">
                    <input type="number" class="form-control form-control-sm" id="vpsReportInterval" placeholder="例如: 60" min="1" style="width: 100px;">
                </div>
                <div class="col-auto">
                    <button type="button" id="saveVpsReportIntervalBtn" class="btn btn-info btn-sm">保存频率</button>
                </div>
            </form>

            <button id="addServerBtn" class="btn btn-primary">
                <i class="bi bi-plus-circle"></i> 添加服务器
            </button>
        </div>
        <div id="serverAlert" class="alert d-none"></div>
        <div class="card">
            <div class="card-body">
                <div class="table-responsive">
                    <table class="table table-striped table-hover">
                        <thead>
                            <tr>
                                <th>排序</th>
                                <th>ID</th>
                                <th>名称</th>
                                <th>描述</th>
                                <th>状态</th>
                                <th>最后更新</th>
                                <th>API密钥</th>
                                <th>VPS脚本</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="serverTableBody">
                            <tr>
                                <td colspan="10" class="text-center">加载中...</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>

    <div class="container mt-5">
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2>网站监控管理</h2>
            <button id="addSiteBtn" class="btn btn-success">
                <i class="bi bi-plus-circle"></i> 添加监控网站
            </button>
        </div>

        <div id="siteAlert" class="alert d-none"></div>

        <div class="card">
            <div class="card-body">
                <div class="table-responsive">
                    <table class="table table-striped table-hover">
                        <thead>
                            <tr>
                                <th>排序</th>
                                <th>名称</th>
                                <th>URL</th>
                                <th>状态</th>
                                <th>状态码</th>
                                <th>响应时间 (ms)</th>
                                <th>最后检查</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="siteTableBody">
                            <tr>
                                <td colspan="10" class="text-center">加载中...</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
    <div class="container mt-5">
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2>Telegram 通知设置</h2>
        </div>
        <div id="telegramSettingsAlert" class="alert d-none"></div>
        <div class="card">
            <div class="card-body">
                <form id="telegramSettingsForm">
                    <div class="mb-3">
                        <label for="telegramBotToken" class="form-label">Bot Token</label>
                        <input type="text" class="form-control" id="telegramBotToken" placeholder="请输入 Telegram Bot Token">
                    </div>
                    <div class="mb-3">
                        <label for="telegramChatId" class="form-label">Chat ID</label>
                        <input type="text" class="form-control" id="telegramChatId" placeholder="请输入接收通知的 Chat ID">
                    </div>
                    <div class="form-check mb-3">
                        <input class="form-check-input" type="checkbox" id="enableTelegramNotifications">
                        <label class="form-check-label" for="enableTelegramNotifications">
                            启用通知
                        </label>
                    </div>
                    <button type="button" id="saveTelegramSettingsBtn" class="btn btn-info">保存Telegram设置</button>
                </form>
            </div>
        </div>
    </div>
    <div class="modal fade" id="serverModal" tabindex="-1">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="serverModalTitle">添加服务器</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="serverForm">
                        <input type="hidden" id="serverId">
                        <div class="mb-3">
                            <label for="serverName" class="form-label">服务器名称</label>
                            <input type="text" class="form-control" id="serverName" required>
                        </div>
                        <div class="mb-3">
                            <label for="serverDescription" class="form-label">描述（可选）</label>
                            <textarea class="form-control" id="serverDescription" rows="2"></textarea>
                        </div>

                        <div id="serverIdDisplayGroup" class="mb-3 d-none">
                            <label for="serverIdDisplay" class="form-label">服务器ID</label>
                            <div class="input-group">
                                <input type="text" class="form-control" id="serverIdDisplay" readonly>
                                <button class="btn btn-outline-secondary" type="button" id="copyServerIdBtn">
                                    <i class="bi bi-clipboard"></i>
                                </button>
                            </div>
                        </div>

                        <div id="workerUrlDisplayGroup" class="mb-3 d-none">
                            <label for="workerUrlDisplay" class="form-label">Worker 地址</label>
                            <div class="input-group">
                                <input type="text" class="form-control" id="workerUrlDisplay" readonly>
                                <button class="btn btn-outline-secondary" type="button" id="copyWorkerUrlBtn">
                                    <i class="bi bi-clipboard"></i>
                                </button>
                            </div>
                        </div>

                        <div id="apiKeyGroup" class="mb-3 d-none">
                            <label for="apiKey" class="form-label">API密钥</label>
                            <div class="input-group">
                                <input type="text" class="form-control" id="apiKey" readonly>
                                <button class="btn btn-outline-secondary" type="button" id="copyApiKeyBtn">
                                    <i class="bi bi-clipboard"></i>
                                </button>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">关闭</button>
                    <button type="button" class="btn btn-primary" id="saveServerBtn">保存</button>
                </div>
            </div>
        </div>
    </div>

    <div class="modal fade" id="siteModal" tabindex="-1">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="siteModalTitle">添加监控网站</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="siteForm">
                        <input type="hidden" id="siteId">
                        <div class="mb-3">
                            <label for="siteName" class="form-label">网站名称（可选）</label>
                            <input type="text" class="form-control" id="siteName">
                        </div>
                        <div class="mb-3">
                            <label for="siteUrl" class="form-label">网站URL</label>
                            <input type="url" class="form-control" id="siteUrl" placeholder="https://example.com" required>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">关闭</button>
                    <button type="button" class="btn btn-primary" id="saveSiteBtn">保存</button>
                </div>
            </div>
        </div>
    </div>

    <div class="modal fade" id="deleteModal" tabindex="-1">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">确认删除</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <p>确定要删除服务器 "<span id="deleteServerName"></span>" 吗？</p>
                    <p class="text-danger">此操作不可逆，所有相关的监控数据也将被删除。</p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
                    <button type="button" class="btn btn-danger" id="confirmDeleteBtn">删除</button>
                </div>
            </div>
        </div>
    </div>

     <div class="modal fade" id="deleteSiteModal" tabindex="-1">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">确认删除网站监控</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <p>确定要停止监控网站 "<span id="deleteSiteName"></span>" (<span id="deleteSiteUrl"></span>) 吗？</p>
                    <p class="text-danger">此操作不可逆。</p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
                    <button type="button" class="btn btn-danger" id="confirmDeleteSiteBtn">删除</button>
                </div>
            </div>
        </div>
    </div>

    <div class="modal fade" id="passwordModal" tabindex="-1">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">修改密码</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div id="passwordAlert" class="alert d-none"></div>
                    <form id="passwordForm">
                        <div class="mb-3">
                            <label for="currentPassword" class="form-label">当前密码</label>
                            <input type="password" class="form-control" id="currentPassword" required>
                        </div>
                        <div class="mb-3">
                            <label for="newPassword" class="form-label">新密码</label>
                            <input type="password" class="form-control" id="newPassword" required>
                        </div>
                        <div class="mb-3">
                            <label for="confirmPassword" class="form-label">确认新密码</label>
                            <input type="password" class="form-control" id="confirmPassword" required>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
                    <button type="button" class="btn btn-primary" id="savePasswordBtn">保存</button>
                </div>
            </div>
        </div>
    </div>

    <footer class="footer mt-5 py-3 bg-light">
        <div class="container text-center">
            <span class="text-muted">&copy; Uptime Status</span>
        </div>
    </footer>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
    <script src="/js/admin.js"></script>
</body>
</html>`;
}

function getStyleCss() {
  return `/* 全局样式 */
body { min-height: 100vh; display: flex; flex-direction: column; }
.footer { margin-top: auto; }
.chart-container { position: relative; height: 200px; width: 100%; }
.card { box-shadow: 0 0.125rem 0.25rem rgba(0, 0, 0, 0.075); margin-bottom: 1.5rem; }
.card-header { background-color: rgba(0, 0, 0, 0.03); border-bottom: 1px solid rgba(0, 0, 0, 0.125); }
.progress { height: 0.75rem; }
.table th { font-weight: 600; }
.modal-dialog { display: flex; align-items: center; min-height: calc(100% - 1rem); }
.modal-content { background-color: rgba(255, 255, 255, 0.9); }
@media (max-width: 768px) { .chart-container { height: 150px; } }
.bg-light-green { background-color: #90ee90 !important; }
#serverAlert, #siteAlert, #telegramSettingsAlert { position: fixed !important; top: 70px; left: 50%; transform: translateX(-50%); z-index: 1055; padding: 0.75rem 1.25rem; border: 1px solid transparent; border-radius: 0.25rem; min-width: 300px; max-width: 90%; text-align: center; box-shadow: 0 0.5rem 1rem rgba(0,0,0,0.15); }
#serverAlert.d-none, #siteAlert.d-none, #telegramSettingsAlert.d-none { display: none !important; }
#serverAlert.alert-success, #siteAlert.alert-success, #telegramSettingsAlert.alert-success { color: #0f5132; background-color: rgba(209, 231, 221, 0.95) !important; border-color: rgba(190, 221, 208, 0.95) !important; }
#serverAlert.alert-danger, #siteAlert.alert-danger, #telegramSettingsAlert.alert-danger { color: #842029; background-color: rgba(248, 215, 218, 0.95) !important; border-color: rgba(245, 198, 203, 0.95) !important; }
#serverAlert.alert-warning, #siteAlert.alert-warning, #telegramSettingsAlert.alert-warning { color: #664d03; background-color: rgba(255, 243, 205, 0.95) !important; border-color: rgba(255, 238, 186, 0.95) !important; }

[data-bs-theme="dark"] {
    body { background-color: #121212; color: #e0e0e0; }
    .card { background-color: #1e1e1e; border: 1px solid #333; color: #e0e0e0; }
    .card-header { background-color: #2a2a2a; border-bottom: 1px solid #333; color: #f5f5f5; }
    .table { color: #e0e0e0; }
    .table th, .table td { border-color: #333; }
    .table-striped > tbody > tr:nth-of-type(odd) > * { background-color: rgba(255, 255, 255, 0.05); color: #e0e0e0; }
    .table-hover > tbody > tr:hover > * { background-color: rgba(255, 255, 255, 0.075); color: #f0f0f0; }
    .modal-content { background-color: rgba(30, 30, 30, 0.9); color: #e0e0e0; }
    .modal-header { border-bottom-color: #333; }
    .modal-footer { border-top-color: #333; }
    .form-control { background-color: #2a2a2a; color: #e0e0e0; border-color: #333; }
    .form-control:focus { background-color: #2a2a2a; color: #e0e0e0; border-color: #555; box-shadow: 0 0 0 0.25rem rgba(100, 100, 100, 0.25); }
    .btn-outline-secondary { color: #adb5bd; border-color: #6c757d; }
    .btn-outline-secondary:hover { color: #fff; background-color: #6c757d; border-color: #6c757d; }
    .navbar { background-color: #1e1e1e !important; }
    .navbar-light .navbar-nav .nav-link { color: #ccc; }
    .navbar-light .navbar-nav .nav-link:hover { color: #fff; }
    .navbar-light .navbar-brand { color: #fff; }
    .footer { background-color: #1e1e1e !important; color: #cccccc; }
    a { color: #8ab4f8; }
    a:hover { color: #a9c9fc; }
    [data-bs-theme="dark"] #serverAlert.alert-success, [data-bs-theme="dark"] #siteAlert.alert-success, [data-bs-theme="dark"] #telegramSettingsAlert.alert-success { color: #75b798; background-color: rgba(40, 167, 69, 0.85) !important; border-color: rgba(34, 139, 57, 0.85) !important; }
    [data-bs-theme="dark"] #serverAlert.alert-danger, [data-bs-theme="dark"] #siteAlert.alert-danger, [data-bs-theme="dark"] #telegramSettingsAlert.alert-danger { color: #ea868f; background-color: rgba(220, 53, 69, 0.85) !important; border-color: rgba(187, 45, 59, 0.85) !important; }
    [data-bs-theme="dark"] #serverAlert.alert-warning, [data-bs-theme="dark"] #siteAlert.alert-warning, [data-bs-theme="dark"] #telegramSettingsAlert.alert-warning { color: #ffd373; background-color: rgba(255, 193, 7, 0.85) !important; border-color: rgba(217, 164, 6, 0.85) !important; }
}
`;
}

function getMainJs() {
  return `// main.js - 首页面的JavaScript逻辑

// Global variables
let vpsUpdateInterval = null;
let siteUpdateInterval = null;
let serverDataCache = {};
const DEFAULT_VPS_REFRESH_INTERVAL_MS = 60000;
const DEFAULT_SITE_REFRESH_INTERVAL_MS = 60000;

// Function to fetch VPS refresh interval and start periodic VPS data updates
async function initializeVpsDataUpdates() {
    let vpsRefreshIntervalMs = DEFAULT_VPS_REFRESH_INTERVAL_MS;
    try {
        const response = await fetch('/api/admin/settings/vps-report-interval');
        if (response.ok) {
            const data = await response.json();
            if (data && typeof data.interval === 'number' && data.interval > 0) {
                vpsRefreshIntervalMs = data.interval * 1000;
                console.log(\`Using backend-defined VPS refresh interval: \${data.interval}s\`);
            } else {
                console.warn('Invalid VPS interval from backend, using default.');
            }
        } else {
            console.warn('Failed to fetch VPS refresh interval from backend, using default.');
        }
    } catch (error) {
        console.error('Error fetching VPS refresh interval, using default:', error);
    }

    if (vpsUpdateInterval) {
        clearInterval(vpsUpdateInterval);
    }

    vpsUpdateInterval = setInterval(() => {
        loadAllServerStatuses();
    }, vpsRefreshIntervalMs);
    console.log(\`VPS data will refresh every \${vpsRefreshIntervalMs / 1000} seconds.\`);
}

// Function to start periodic site status updates
function initializeSiteDataUpdates() {
    const siteRefreshIntervalMs = DEFAULT_SITE_REFRESH_INTERVAL_MS;
    if (siteUpdateInterval) {
        clearInterval(siteUpdateInterval);
    }
    siteUpdateInterval = setInterval(() => {
        loadAllSiteStatuses();
    }, siteRefreshIntervalMs);
    console.log(\`Site status data will refresh every \${siteRefreshIntervalMs / 1000} seconds.\`);
}

document.addEventListener('DOMContentLoaded', function() {
    initializeTheme();
    loadAllServerStatuses();
    loadAllSiteStatuses();
    initializeVpsDataUpdates();
    initializeSiteDataUpdates();
    document.getElementById('serverTableBody').addEventListener('click', handleRowClick);
    updateAdminLink();
});

// --- Theme Management ---
const THEME_KEY = 'themePreference';
const LIGHT_THEME = 'light';
const DARK_THEME = 'dark';
function initializeTheme() {
    const themeToggler = document.getElementById('themeToggler');
    if (!themeToggler) return;
    const storedTheme = localStorage.getItem(THEME_KEY) || LIGHT_THEME;
    applyTheme(storedTheme);
    themeToggler.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-bs-theme');
        const newTheme = currentTheme === DARK_THEME ? LIGHT_THEME : DARK_THEME;
        applyTheme(newTheme);
        localStorage.setItem(THEME_KEY, newTheme);
    });
}
function applyTheme(theme) {
    document.documentElement.setAttribute('data-bs-theme', theme);
    const themeTogglerIcon = document.querySelector('#themeToggler i');
    if (themeTogglerIcon) {
        if (theme === DARK_THEME) {
            themeTogglerIcon.classList.remove('bi-moon-stars-fill');
            themeTogglerIcon.classList.add('bi-sun-fill');
        } else {
            themeTogglerIcon.classList.remove('bi-sun-fill');
            themeTogglerIcon.classList.add('bi-moon-stars-fill');
        }
    }
}
// --- End Theme Management ---

async function updateAdminLink() {
    const adminLink = document.getElementById('adminAuthLink');
    if (!adminLink) return;
    try {
        const token = localStorage.getItem('auth_token');
        if (!token) {
            adminLink.textContent = '管理员登录';
            adminLink.href = '/login.html';
            return;
        }
        const response = await fetch('/api/auth/status', {
            headers: { 'Authorization': \`Bearer \${token}\` }
        });
        if (response.ok) {
            const data = await response.json();
            if (data.authenticated) {
                adminLink.textContent = '管理后台';
                adminLink.href = '/admin.html';
            } else {
                adminLink.textContent = '管理员登录';
                adminLink.href = '/login.html';
                localStorage.removeItem('auth_token');
            }
        } else {
            adminLink.textContent = '管理员登录';
            adminLink.href = '/login.html';
        }
    } catch (error) {
        console.error('Error checking auth status for navbar link:', error);
        adminLink.textContent = '管理员登录';
        adminLink.href = '/login.html';
    }
}

function handleRowClick(event) {
    const clickedRow = event.target.closest('tr.server-row');
    if (!clickedRow) return;
    const serverId = clickedRow.getAttribute('data-server-id');
    const detailsRow = clickedRow.nextElementSibling;
    if (detailsRow && detailsRow.classList.contains('server-details-row')) {
        detailsRow.classList.toggle('d-none');
        if (!detailsRow.classList.contains('d-none')) {
            populateDetailsRow(serverId, detailsRow);
        }
    }
}

function populateDetailsRow(serverId, detailsRow) {
    const serverData = serverDataCache[serverId];
    const detailsContentDiv = detailsRow.querySelector('.server-details-content');
    if (!serverData || !serverData.metrics || !detailsContentDiv) {
        detailsContentDiv.innerHTML = '<p class="text-muted">无详细数据</p>';
        return;
    }
    const metrics = serverData.metrics;
    let detailsHtml = '';
    if (metrics.cpu && metrics.cpu.load_avg) {
        detailsHtml += \`
            <div class="detail-item">
                <strong>CPU负载 (1m, 5m, 15m):</strong> \${metrics.cpu.load_avg.join(', ')}
            </div>
        \`;
    }
    if (metrics.memory) {
        detailsHtml += \`
            <div class="detail-item">
                <strong>内存:</strong>
                总计: \${formatDataSize(metrics.memory.total * 1024)}<br>
                已用: \${formatDataSize(metrics.memory.used * 1024)}<br>
                空闲: \${formatDataSize(metrics.memory.free * 1024)}
            </div>
        \`;
    }
    if (metrics.disk) {
         detailsHtml += \`
            <div class="detail-item">
                <strong>硬盘 (/):</strong>
                总计: \${metrics.disk.total.toFixed(2)} GB<br>
                已用: \${metrics.disk.used.toFixed(2)} GB<br>
                空闲: \${metrics.disk.free.toFixed(2)} GB
            </div>
        \`;
    }
    if (metrics.network) {
        detailsHtml += \`
            <div class="detail-item">
                <strong>总流量:</strong>
                上传: \${formatDataSize(metrics.network.total_upload)}<br>
                下载: \${formatDataSize(metrics.network.total_download)}
            </div>
        \`;
    }
    detailsContentDiv.innerHTML = detailsHtml || '<p class="text-muted">无详细数据</p>';
}


async function loadAllServerStatuses() {
    try {
        const serversResponse = await fetch('/api/servers');
        if (!serversResponse.ok) {
            throw new Error('Failed to get server list');
        }
        const serversData = await serversResponse.json();
        const servers = serversData.servers || [];
        const noServersAlert = document.getElementById('noServers');
        const serverTableBody = document.getElementById('serverTableBody');

        if (servers.length === 0) {
            noServersAlert.classList.remove('d-none');
            serverTableBody.innerHTML = '<tr><td colspan="12" class="text-center">No server data available. Please log in to the admin panel to add servers.</td></tr>';
            removeAllDetailRows();
            return;
        } else {
            noServersAlert.classList.add('d-none');
        }

        const statusPromises = servers.map(server =>
            fetch(\`/api/status/\${server.id}\`)
                .then(res => res.ok ? res.json() : Promise.resolve({ server: server, metrics: null, error: true }))
                .catch(() => Promise.resolve({ server: server, metrics: null, error: true }))
        );

        const allStatuses = await Promise.all(statusPromises);
        allStatuses.forEach(data => {
             serverDataCache[data.server.id] = data;
        });
        renderServerTable(allStatuses);
    } catch (error) {
        console.error('Error loading server statuses:', error);
        const serverTableBody = document.getElementById('serverTableBody');
        serverTableBody.innerHTML = '<tr><td colspan="12" class="text-center text-danger">Failed to load server data. Please refresh the page.</td></tr>';
         removeAllDetailRows();
    }
}

function removeAllDetailRows() {
    document.querySelectorAll('.server-details-row').forEach(row => row.remove());
}


function getProgressBarHtml(percentage) {
    if (typeof percentage !== 'number' || isNaN(percentage)) return '-';
    const percent = Math.max(0, Math.min(100, percentage));
    let bgColorClass = 'bg-light-green';
    if (percent >= 80) {
        bgColorClass = 'bg-danger';
    } else if (percent >= 50) {
        bgColorClass = 'bg-warning';
    }

    return \`
        <div class="progress" style="height: 25px; font-size: 0.8em; position: relative; background-color: #e9ecef;">
            <div class="progress-bar \${bgColorClass}" role="progressbar" style="width: \${percent}%;"
                aria-valuenow="\${percent}" aria-valuemin="0" aria-valuemax="100"></div>
            <span style="position: absolute; width: 100%; text-align: center; line-height: 25px; font-weight: bold;">
                \${percent.toFixed(1)}%
            </span>
        </div>
    \`;
}


function renderServerTable(allStatuses) {
    const tableBody = document.getElementById('serverTableBody');
    const detailsTemplate = document.getElementById('serverDetailsTemplate');

    const expandedServerIds = new Set();
    tableBody.querySelectorAll('tr.server-row').forEach(mainRow => {
        const detailRow = mainRow.nextElementSibling;
        if (detailRow && detailRow.classList.contains('server-details-row') && !detailRow.classList.contains('d-none')) {
            const serverId = mainRow.getAttribute('data-server-id');
            if (serverId) {
                expandedServerIds.add(serverId);
            }
        }
    });

    tableBody.innerHTML = '';

    allStatuses.forEach(data => {
        const serverId = data.server.id;
        const serverName = data.server.name;
        const metrics = data.metrics;
        const hasError = data.error;

        let statusBadge = '<span class="badge bg-secondary">未知</span>';
        let cpuHtml = '-';
        let memoryHtml = '-';
        let diskHtml = '-';
        let uploadSpeed = '-';
        let downloadSpeed = '-';
        let totalUpload = '-';
        let totalDownload = '-';
        let uptime = '-';
        let lastUpdate = '-';
        let pingHtml = '-'; // 新增

        if (hasError) {
            statusBadge = '<span class="badge bg-warning text-dark">错误</span>';
        } else if (metrics) {
            const now = new Date();
            const lastReportTime = new Date(metrics.timestamp * 1000);
            const diffMinutes = (now - lastReportTime) / (1000 * 60);

            if (diffMinutes <= 5) {
                statusBadge = '<span class="badge bg-success">在线</span>';
            } else {
                statusBadge = '<span class="badge bg-danger">离线</span>';
            }

            cpuHtml = getProgressBarHtml(metrics.cpu.usage_percent);
            memoryHtml = getProgressBarHtml(metrics.memory.usage_percent);
            diskHtml = getProgressBarHtml(metrics.disk.usage_percent);
            uploadSpeed = formatNetworkSpeed(metrics.network.upload_speed);
            downloadSpeed = formatNetworkSpeed(metrics.network.download_speed);
            totalUpload = formatDataSize(metrics.network.total_upload);
            totalDownload = formatDataSize(metrics.network.total_download);
            uptime = metrics.uptime ? formatUptime(metrics.uptime) : '-';
            lastUpdate = lastReportTime.toLocaleString();

            // 渲染丢包率
             if (metrics.ping) {
                const getLossClass = (loss) => {
                    if (loss === undefined || loss === null) return 'text-muted';
                    if (loss == 0) return 'text-success';
                    if (loss < 10) return 'text-warning';
                    return 'text-danger';
                };
                const cu = metrics.ping.cu !== undefined ? metrics.ping.cu + '%' : '-';
                const ct = metrics.ping.ct !== undefined ? metrics.ping.ct + '%' : '-';
                const cm = metrics.ping.cm !== undefined ? metrics.ping.cm + '%' : '-';
                
                pingHtml = \`
                    <span class="\${getLossClass(metrics.ping.cu)}" title="联通">\${cu}</span> | 
                    <span class="\${getLossClass(metrics.ping.ct)}" title="电信">\${ct}</span> | 
                    <span class="\${getLossClass(metrics.ping.cm)}" title="移动">\${cm}</span>
                \`;
            }
        }

        const mainRow = document.createElement('tr');
        mainRow.classList.add('server-row');
        mainRow.setAttribute('data-server-id', serverId);
        mainRow.innerHTML = \`
            <td>\${serverName}</td>
            <td>\${statusBadge}</td>
            <td>\${cpuHtml}</td>
            <td>\${memoryHtml}</td>
            <td>\${diskHtml}</td>
            <td class="text-center">\${pingHtml}</td>
            <td><span style="color: #000;">\${uploadSpeed}</span></td>
            <td><span style="color: #000;">\${downloadSpeed}</span></td>
            <td><span style="color: #000;">\${totalUpload}</span></td>
            <td><span style="color: #000;">\${totalDownload}</span></td>
            <td><span style="color: #000;">\${uptime}</span></td>
            <td><span style="color: #000;">\${lastUpdate}</span></td>
        \`;
        
        const detailsRowElement = detailsTemplate.content.cloneNode(true).querySelector('tr');
        tableBody.appendChild(mainRow);
        tableBody.appendChild(detailsRowElement);

        if (expandedServerIds.has(serverId)) {
            detailsRowElement.classList.remove('d-none');
            populateDetailsRow(serverId, detailsRowElement);
        }
    });
}


function formatNetworkSpeed(bytesPerSecond) {
    if (typeof bytesPerSecond !== 'number' || isNaN(bytesPerSecond)) return '-';
    if (bytesPerSecond < 1024) {
        return \`\${bytesPerSecond.toFixed(1)} B/s\`;
    } else if (bytesPerSecond < 1024 * 1024) {
        return \`\${(bytesPerSecond / 1024).toFixed(1)} KB/s\`;
    } else if (bytesPerSecond < 1024 * 1024 * 1024) {
        return \`\${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s\`;
    } else {
        return \`\${(bytesPerSecond / (1024 * 1024 * 1024)).toFixed(1)} GB/s\`;
    }
}

function formatDataSize(bytes) {
    if (typeof bytes !== 'number' || isNaN(bytes)) return '-';
    if (bytes < 1024) {
        return \`\${bytes.toFixed(1)} B\`;
    } else if (bytes < 1024 * 1024) {
        return \`\${(bytes / 1024).toFixed(1)} KB\`;
    } else if (bytes < 1024 * 1024 * 1024) {
        return \`\${(bytes / (1024 * 1024)).toFixed(1)} MB\`;
    } else if (bytes < 1024 * 1024 * 1024 * 1024) {
        return \`\${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB\`;
    } else {
        return \`\${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB\`;
    }
}

function formatUptime(totalSeconds) {
    if (typeof totalSeconds !== 'number' || isNaN(totalSeconds) || totalSeconds < 0) {
        return '-';
    }
    const days = Math.floor(totalSeconds / (3600 * 24));
    totalSeconds %= (3600 * 24);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);

    let uptimeString = '';
    if (days > 0) {
        uptimeString += \`\${days}天 \`;
    }
    if (hours > 0) {
        uptimeString += \`\${hours}小时 \`;
    }
    if (minutes > 0 || (days === 0 && hours === 0)) {
        uptimeString += \`\${minutes}分钟\`;
    }
    return uptimeString.trim() || '0分钟';
}


// --- Website Status Functions ---

async function loadAllSiteStatuses() {
    try {
        const response = await fetch('/api/sites/status');
        if (!response.ok) {
            throw new Error('Failed to get website status list');
        }
        const data = await response.json();
        const sites = data.sites || [];
        const noSitesAlert = document.getElementById('noSites');
        const siteStatusTableBody = document.getElementById('siteStatusTableBody');

        if (sites.length === 0) {
            noSitesAlert.classList.remove('d-none');
            siteStatusTableBody.innerHTML = '<tr><td colspan="6" class="text-center">No websites are being monitored.</td></tr>';
            return;
        } else {
            noSitesAlert.classList.add('d-none');
        }
        renderSiteStatusTable(sites);
    } catch (error) {
        console.error('Error loading website statuses:', error);
        const siteStatusTableBody = document.getElementById('siteStatusTableBody');
        siteStatusTableBody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Failed to load website status data. Please refresh the page.</td></tr>';
    }
}

async function renderSiteStatusTable(sites) {
    const tableBody = document.getElementById('siteStatusTableBody');
    tableBody.innerHTML = '';

    for (const site of sites) {
        const row = document.createElement('tr');
        const statusInfo = getSiteStatusBadge(site.last_status);
        const lastCheckTime = site.last_checked ? new Date(site.last_checked * 1000).toLocaleString() : '从未';
        const responseTime = site.last_response_time_ms !== null ? \`\${site.last_response_time_ms} ms\` : '-';

        const historyCell = document.createElement('td');
        historyCell.innerHTML = '<div class="history-bar-container"></div>';

        row.innerHTML = \`
            <td>\${site.name || '-'}</td>
            <td><span class="badge \${statusInfo.class}">\${statusInfo.text}</span></td>
            <td>\${site.last_status_code || '-'}</td>
            <td>\${responseTime}</td>
            <td>\${lastCheckTime}</td>
        \`;
        row.appendChild(historyCell);
        tableBody.appendChild(row);
        fetchAndRenderSiteHistory(site.id, historyCell.querySelector('.history-bar-container'));
    }
}

async function fetchAndRenderSiteHistory(siteId, containerElement) {
    try {
        const response = await fetch(\`/api/sites/\${siteId}/history\`);
        if (!response.ok) {
            console.warn(\`Failed to fetch history for site \${siteId}\`);
            containerElement.innerHTML = '<small class="text-muted">Error fetching</small>';
            return;
        }
        const data = await response.json();
        const fetchedHistory = data.history || [];

        let historyHtml = '';
        const now = new Date();
        
        for (let i = 0; i < 24; i++) {
            const slotTime = new Date(now);
            slotTime.setHours(now.getHours() - i);

            const slotStart = new Date(slotTime);
            slotStart.setMinutes(0, 0, 0);

            const slotEnd = new Date(slotTime);
            slotEnd.setMinutes(59, 59, 999);

            const slotStartTimestamp = Math.floor(slotStart.getTime() / 1000);
            const slotEndTimestamp = Math.floor(slotEnd.getTime() / 1000);

            const recordForHour = fetchedHistory.find(
                r => r.timestamp >= slotStartTimestamp && r.timestamp <= slotEndTimestamp
            );
            let barClass = 'history-bar-pending';
            let titleText = \`\${String(slotStart.getHours()).padStart(2, '0')}:00 - \${String((slotStart.getHours() + 1) % 24).padStart(2, '0')}:00: No record\`;
            if (recordForHour) {
                if (recordForHour.status === 'UP') {
                    barClass = 'history-bar-up';
                } else if (['DOWN', 'TIMEOUT', 'ERROR'].includes(recordForHour.status)) {
                    barClass = 'history-bar-down';
                }
                const recordDate = new Date(recordForHour.timestamp * 1000);
                titleText = \`\${recordDate.toLocaleString()}: \${recordForHour.status} (\${recordForHour.status_code || 'N/A'}), \${recordForHour.response_time_ms || '-'}\`;
            }
            historyHtml += \`<div class="history-bar \${barClass}" title="\${titleText}"></div>\`;
        }
        
        if (!historyHtml) {
             containerElement.innerHTML = '<small class="text-muted">No records for last 24h</small>';
        } else {
             containerElement.innerHTML = historyHtml;
        }

    } catch (error) {
        console.error(\`Error fetching/rendering history for site \${siteId}:\`, error);
        containerElement.innerHTML = '<small class="text-muted">Error rendering</small>';
    }
}

function getSiteStatusBadge(status) {
    switch (status) {
        case 'UP': return { class: 'bg-success', text: '正常' };
        case 'DOWN': return { class: 'bg-danger', text: '故障' };
        case 'TIMEOUT': return { class: 'bg-warning text-dark', text: '超时' };
        case 'ERROR': return { class: 'bg-danger', text: '错误' };
        case 'PENDING': return { class: 'bg-secondary', text: '待检测' };
        default: return { class: 'bg-secondary', text: '未知' };
    }
}
`;
}

function getLoginJs() {
  return `// login.js - 登录页面的JavaScript逻辑
// --- Theme Management ---
const THEME_KEY = 'themePreference';
const LIGHT_THEME = 'light';
const DARK_THEME = 'dark';
function initializeTheme() {
    const themeToggler = document.getElementById('themeToggler');
    if (!themeToggler) return;
    const storedTheme = localStorage.getItem(THEME_KEY) || LIGHT_THEME;
    applyTheme(storedTheme);
    themeToggler.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-bs-theme');
        const newTheme = currentTheme === DARK_THEME ? LIGHT_THEME : DARK_THEME;
        applyTheme(newTheme);
        localStorage.setItem(THEME_KEY, newTheme);
    });
}
function applyTheme(theme) {
    document.title = \`Admin Panel - Theme: \${theme.toUpperCase()}\`;
    document.documentElement.setAttribute('data-bs-theme', theme);
    const themeTogglerIcon = document.querySelector('#themeToggler i');
    if (themeTogglerIcon) {
        if (theme === DARK_THEME) {
            themeTogglerIcon.classList.remove('bi-moon-stars-fill');
            themeTogglerIcon.classList.add('bi-sun-fill');
        } else {
            themeTogglerIcon.classList.remove('bi-sun-fill');
            themeTogglerIcon.classList.add('bi-moon-stars-fill');
        }
    }
}
// --- End Theme Management ---

document.addEventListener('DOMContentLoaded', function() {
    initializeTheme();
    const loginForm = document.getElementById('loginForm');
    const loginAlert = document.getElementById('loginAlert');
    
    loginForm.addEventListener('submit', function(e) {
        e.preventDefault();
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value.trim();
        if (!username || !password) {
            showLoginError('请输入用户名和密码');
            return;
        }
        login(username, password);
    });
    checkLoginStatus();
});

async function checkLoginStatus() {
    try {
        const token = localStorage.getItem('auth_token');
        if (!token) return;
        const response = await fetch('/api/auth/status', {
            headers: { 'Authorization': \`Bearer \${token}\` }
        });
        if (response.ok) {
            const data = await response.json();
            if (data.authenticated) {
                window.location.href = 'admin.html';
            }
        }
    } catch (error) {
        console.error('检查登录状态错误:', error);
    }
}

async function login(username, password) {
    try {
        const submitBtn = loginForm.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 登录中...';
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnText;
        if (response.ok) {
            const data = await response.json();
            localStorage.setItem('auth_token', data.token);
            window.location.href = 'admin.html';
        } else {
            const data = await response.json();
            showLoginError(data.message || '用户名或密码错误');
        }
    } catch (error) {
        console.error('登录错误:', error);
        showLoginError('登录请求失败，请稍后重试');
    }
}

function showLoginError(message) {
    const loginAlert = document.getElementById('loginAlert');
    loginAlert.textContent = message;
    loginAlert.classList.remove('d-none');
    setTimeout(() => {
        loginAlert.classList.add('d-none');
    }, 5000);
}`;
}

function getAdminJs() {
  return `// admin.js - 管理后台的JavaScript逻辑
// --- Theme Management ---
const THEME_KEY = 'themePreference';
const LIGHT_THEME = 'light';
const DARK_THEME = 'dark';
function initializeTheme() {
    const themeToggler = document.getElementById('themeToggler');
    if (!themeToggler) return;
    const storedTheme = localStorage.getItem(THEME_KEY) || LIGHT_THEME;
    applyTheme(storedTheme);
    themeToggler.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-bs-theme');
        const newTheme = currentTheme === DARK_THEME ? LIGHT_THEME : DARK_THEME;
        applyTheme(newTheme);
        localStorage.setItem(THEME_KEY, newTheme);
    });
}
function applyTheme(theme) {
    document.documentElement.setAttribute('data-bs-theme', theme);
    const themeTogglerIcon = document.querySelector('#themeToggler i');
    if (themeTogglerIcon) {
        if (theme === DARK_THEME) {
            themeTogglerIcon.classList.remove('bi-moon-stars-fill');
            themeTogglerIcon.classList.add('bi-sun-fill');
        } else {
            themeTogglerIcon.classList.remove('bi-sun-fill');
            themeTogglerIcon.classList.add('bi-moon-stars-fill');
        }
    }
}
// --- End Theme Management ---

let currentServerId = null;
let currentSiteId = null;
let serverList = [];
let siteList = [];

document.addEventListener('DOMContentLoaded', function() {
    initializeTheme();
    checkLoginStatus();
    initEventListeners();
    loadServerList();
    loadSiteList();
    loadTelegramSettings();
    loadGlobalSettings();
});

async function checkLoginStatus() {
    try {
        const token = localStorage.getItem('auth_token');
        if (!token) {
            window.location.href = 'login.html';
            return;
        }
        const response = await fetch('/api/auth/status', {
            headers: { 'Authorization': \`Bearer \${token}\` }
        });
        if (response.ok) {
            const data = await response.json();
            if (!data.authenticated) {
                window.location.href = 'login.html';
            }
        } else {
            window.location.href = 'login.html';
        }
    } catch (error) {
        console.error('检查登录状态错误:', error);
        window.location.href = 'login.html';
    }
}

function initEventListeners() {
    document.getElementById('addServerBtn').addEventListener('click', function() { showServerModal(); });
    document.getElementById('saveServerBtn').addEventListener('click', function() { saveServer(); });
    document.getElementById('copyApiKeyBtn').addEventListener('click', function() { copyToClipboard(document.getElementById('apiKey').value, this); });
    document.getElementById('copyServerIdBtn').addEventListener('click', function() { copyToClipboard(document.getElementById('serverIdDisplay').value, this); });
    document.getElementById('copyWorkerUrlBtn').addEventListener('click', function() { copyToClipboard(document.getElementById('workerUrlDisplay').value, this); });
    document.getElementById('confirmDeleteBtn').addEventListener('click', function() { if (currentServerId) deleteServer(currentServerId); });
    document.getElementById('changePasswordBtn').addEventListener('click', function() { showPasswordModal(); });
    document.getElementById('savePasswordBtn').addEventListener('click', function() { changePassword(); });
    document.getElementById('logoutBtn').addEventListener('click', function() { logout(); });
    document.getElementById('addSiteBtn').addEventListener('click', function() { showSiteModal(); });
    document.getElementById('saveSiteBtn').addEventListener('click', function() { saveSite(); });
    document.getElementById('confirmDeleteSiteBtn').addEventListener('click', function() { if (currentSiteId) deleteSite(currentSiteId); });
    document.getElementById('saveTelegramSettingsBtn').addEventListener('click', function() { saveTelegramSettings(); });
    document.getElementById('saveVpsReportIntervalBtn').addEventListener('click', function() { saveVpsReportInterval(); });
}

function copyToClipboard(textToCopy, buttonElement) {
    navigator.clipboard.writeText(textToCopy).then(() => {
        const originalHtml = buttonElement.innerHTML;
        buttonElement.innerHTML = '<i class="bi bi-check-lg"></i>';
        buttonElement.classList.add('btn-success');
        buttonElement.classList.remove('btn-outline-secondary');
        setTimeout(() => {
            buttonElement.innerHTML = originalHtml;
            buttonElement.classList.remove('btn-success');
            buttonElement.classList.add('btn-outline-secondary');
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy text: ', err);
        const originalHtml = buttonElement.innerHTML;
        buttonElement.innerHTML = '<i class="bi bi-x-lg"></i>';
        buttonElement.classList.add('btn-danger');
        buttonElement.classList.remove('btn-outline-secondary');
        setTimeout(() => {
            buttonElement.innerHTML = originalHtml;
            buttonElement.classList.remove('btn-danger');
            buttonElement.classList.add('btn-outline-secondary');
        }, 2000);
    });
}

function getAuthHeaders() {
    const token = localStorage.getItem('auth_token');
    return {
        'Content-Type': 'application/json',
        'Authorization': \`Bearer \${token}\`
    };
}

async function loadServerList() {
    try {
        const response = await fetch('/api/admin/servers', { headers: getAuthHeaders() });
        if (!response.ok) throw new Error('获取服务器列表失败');
        const data = await response.json();
        serverList = data.servers || [];
        renderServerTable(serverList);
    } catch (error) {
        console.error('加载服务器列表错误:', error);
        showAlert('danger', '加载服务器列表失败，请刷新页面重试。', 'serverAlert');
    }
}

function renderServerTable(servers) {
    const tableBody = document.getElementById('serverTableBody');
    tableBody.innerHTML = '';
    if (servers.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="9" class="text-center">暂无服务器数据</td></tr>';
        return;
    }
    
    servers.forEach((server, index) => {
        const row = document.createElement('tr');
        let lastUpdateText = '从未';
        let statusBadge = '<span class="badge bg-secondary">未知</span>';
        if (server.last_report) {
            const lastUpdate = new Date(server.last_report * 1000);
            lastUpdateText = lastUpdate.toLocaleString();
            const now = new Date();
            const diffMinutes = (now - lastUpdate) / (1000 * 60);
            if (diffMinutes <= 5) {
                statusBadge = '<span class="badge bg-success">在线</span>';
            } else {
                statusBadge = '<span class="badge bg-danger">离线</span>';
            }
        }
        
        row.innerHTML = \`
            <td>
                <div class="btn-group">
                     <button class="btn btn-sm btn-outline-secondary move-server-btn" data-id="\${server.id}" data-direction="up" \${index === 0 ? 'disabled' : ''}><i class="bi bi-arrow-up"></i></button>
                     <button class="btn btn-sm btn-outline-secondary move-server-btn" data-id="\${server.id}" data-direction="down" \${index === servers.length - 1 ? 'disabled' : ''}><i class="bi bi-arrow-down"></i></button>
                </div>
            </td>
            <td>\${server.id}</td>
            <td>\${server.name}</td>
            <td>\${server.description || '-'}</td>
            <td>\${statusBadge}</td>
            <td>\${lastUpdateText}</td>
            <td>
                <button class="btn btn-sm btn-outline-secondary view-key-btn" data-id="\${server.id}"><i class="bi bi-key"></i> 查看密钥</button>
            </td>
            <td>
                <button class="btn btn-sm btn-outline-info copy-vps-script-btn" data-id="\${server.id}" data-name="\${server.name}" title="复制VPS安装脚本"><i class="bi bi-clipboard-plus"></i> 复制脚本</button>
            </td>
            <td>
                <div class="btn-group">
                    <button class="btn btn-sm btn-outline-primary edit-server-btn" data-id="\${server.id}"><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-sm btn-outline-danger delete-server-btn" data-id="\${server.id}" data-name="\${server.name}"><i class="bi bi-trash"></i></button>
                </div>
            </td>
        \`;
        tableBody.appendChild(row);
    });
    
    document.querySelectorAll('.view-key-btn').forEach(btn => btn.addEventListener('click', function() { viewApiKey(this.getAttribute('data-id')); }));
    document.querySelectorAll('.edit-server-btn').forEach(btn => btn.addEventListener('click', function() { editServer(this.getAttribute('data-id')); }));
    document.querySelectorAll('.delete-server-btn').forEach(btn => btn.addEventListener('click', function() { showDeleteConfirmation(this.getAttribute('data-id'), this.getAttribute('data-name')); }));
    document.querySelectorAll('.move-server-btn').forEach(btn => btn.addEventListener('click', function() { moveServer(this.getAttribute('data-id'), this.getAttribute('data-direction')); }));
    document.querySelectorAll('.copy-vps-script-btn').forEach(btn => btn.addEventListener('click', function() { copyVpsInstallScript(this.getAttribute('data-id'), this.getAttribute('data-name'), this); }));
}

async function copyVpsInstallScript(serverId, serverName, buttonElement) {
    const originalButtonHtml = buttonElement.innerHTML;
    buttonElement.disabled = true;
    buttonElement.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 获取中...';
    try {
        const apiKeyResponse = await fetch(\`/api/admin/servers/\${serverId}/key\`, { headers: getAuthHeaders() });
        if (!apiKeyResponse.ok) throw new Error('获取API密钥失败');
        const apiKeyData = await apiKeyResponse.json();
        const apiKey = apiKeyData.api_key;
        if (!apiKey) throw new Error('未能获取到API密钥');

        let vpsReportInterval = 60;
        try {
            const intervalResponse = await fetch('/api/admin/settings/vps-report-interval', { headers: getAuthHeaders() });
            if (intervalResponse.ok) {
                const intervalData = await intervalResponse.json();
                if (intervalData && typeof intervalData.interval === 'number' && intervalData.interval > 0) {
                    vpsReportInterval = intervalData.interval;
                }
            }
        } catch (e) {}
        
        const workerUrl = window.location.origin;
        const scriptCommand = \`curl -fsSL "\${workerUrl}/install.sh" -o install.sh && chmod +x install.sh && sudo ./install.sh -k \${apiKey} -s \${serverId} -u \${workerUrl}\`;
        
        await navigator.clipboard.writeText(scriptCommand);
        buttonElement.innerHTML = '<i class="bi bi-check-lg"></i> 已复制!';
        buttonElement.classList.remove('btn-outline-info');
        buttonElement.classList.add('btn-success');
        showAlert('success', \`服务器 "\${serverName}" 的安装脚本已复制到剪贴板。\`, 'serverAlert');
    } catch (error) {
        console.error('复制VPS安装脚本错误:', error);
        showAlert('danger', \`复制脚本失败: \${error.message}\`, 'serverAlert');
        buttonElement.innerHTML = '<i class="bi bi-x-lg"></i> 复制失败';
        buttonElement.classList.remove('btn-outline-info');
        buttonElement.classList.add('btn-danger');
    } finally {
        setTimeout(() => {
            buttonElement.disabled = false;
            buttonElement.innerHTML = originalButtonHtml;
            buttonElement.classList.remove('btn-success', 'btn-danger');
            buttonElement.classList.add('btn-outline-info');
        }, 3000);
    }
}

async function moveServer(serverId, direction) {
    try {
        const response = await fetch(\`/api/admin/servers/\${serverId}/reorder\`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ direction })
        });
        if (!response.ok) throw new Error('移动服务器失败');
        await loadServerList();
        showAlert('success', '服务器已成功' + (direction === 'up' ? '上移' : '下移'));
    } catch (error) {
        console.error('移动服务器错误:', error);
        showAlert('danger', \`移动服务器失败: \${error.message}\`, 'serverAlert');
    }
}

function showServerModal() {
    document.getElementById('serverForm').reset();
    document.getElementById('serverId').value = '';
    document.getElementById('apiKeyGroup').classList.add('d-none');
    document.getElementById('serverIdDisplayGroup').classList.add('d-none');
    document.getElementById('workerUrlDisplayGroup').classList.add('d-none');
    document.getElementById('serverModalTitle').textContent = '添加服务器';
    new bootstrap.Modal(document.getElementById('serverModal')).show();
}

function editServer(serverId) {
    const server = serverList.find(s => s.id === serverId);
    if (!server) return;
    document.getElementById('serverId').value = server.id;
    document.getElementById('serverName').value = server.name;
    document.getElementById('serverDescription').value = server.description || '';
    document.getElementById('apiKeyGroup').classList.add('d-none');
    document.getElementById('serverIdDisplayGroup').classList.add('d-none');
    document.getElementById('workerUrlDisplayGroup').classList.add('d-none');
    document.getElementById('serverModalTitle').textContent = '编辑服务器';
    new bootstrap.Modal(document.getElementById('serverModal')).show();
}

async function saveServer() {
    const serverId = document.getElementById('serverId').value;
    const serverName = document.getElementById('serverName').value.trim();
    const serverDescription = document.getElementById('serverDescription').value.trim();
    if (!serverName) {
        showAlert('danger', '服务器名称不能为空', 'serverAlert');
        return;
    }
    try {
        let response;
        if (serverId) {
            response = await fetch(\`/api/admin/servers/\${serverId}\`, {
                method: 'PUT',
                headers: getAuthHeaders(),
                body: JSON.stringify({ name: serverName, description: serverDescription })
            });
        } else {
            response = await fetch('/api/admin/servers', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ name: serverName, description: serverDescription })
            });
        }
        if (!response.ok) throw new Error('保存服务器失败');
        const data = await response.json();
        bootstrap.Modal.getInstance(document.getElementById('serverModal')).hide();
        if (!serverId && data.server && data.server.api_key) {
            showApiKey(data.server);
        } else {
            loadServerList();
            showAlert('success', serverId ? '服务器更新成功' : '服务器添加成功');
        }
    } catch (error) {
        console.error('保存服务器错误:', error);
        showAlert('danger', '保存服务器失败，请稍后重试', 'serverAlert');
    }
}

async function viewApiKey(serverId) {
    try {
        const response = await fetch(\`/api/admin/servers/\${serverId}/key\`, { headers: getAuthHeaders() });
        if (!response.ok) throw new Error('获取API密钥失败');
        const data = await response.json();
        if (data.api_key) {
            const server = serverList.find(s => s.id === serverId);
            if (server) showApiKey({ ...server, api_key: data.api_key });
            else showAlert('danger', '未找到服务器信息', 'serverAlert');
        } else {
            showAlert('danger', '获取API密钥失败', 'serverAlert');
        }
    } catch (error) {
        console.error('查看API密钥错误:', error);
        showAlert('danger', '获取API密钥失败，请稍后重试', 'serverAlert');
    }
}

function showApiKey(server) {
    document.getElementById('serverId').value = server.id;
    document.getElementById('serverName').value = server.name;
    document.getElementById('serverDescription').value = server.description || '';
    document.getElementById('apiKey').value = server.api_key;
    document.getElementById('apiKeyGroup').classList.remove('d-none');
    document.getElementById('serverIdDisplay').value = server.id;
    document.getElementById('serverIdDisplayGroup').classList.remove('d-none');
    document.getElementById('workerUrlDisplay').value = window.location.origin;
    document.getElementById('workerUrlDisplayGroup').classList.remove('d-none');
    document.getElementById('serverModalTitle').textContent = '服务器详细信息与密钥';
    new bootstrap.Modal(document.getElementById('serverModal')).show();
}

function showDeleteConfirmation(serverId, serverName) {
    currentServerId = serverId;
    document.getElementById('deleteServerName').textContent = serverName;
    new bootstrap.Modal(document.getElementById('deleteModal')).show();
}

async function deleteServer(serverId) {
    try {
        const response = await fetch(\`/api/admin/servers/\${serverId}\`, { method: 'DELETE', headers: getAuthHeaders() });
        if (!response.ok) throw new Error('删除服务器失败');
        bootstrap.Modal.getInstance(document.getElementById('deleteModal')).hide();
        loadServerList();
        showAlert('success', '服务器删除成功');
    } catch (error) {
        console.error('删除服务器错误:', error);
        showAlert('danger', '删除服务器失败，请稍后重试', 'serverAlert');
    }
}

async function moveSite(siteId, direction) {
    try {
        const response = await fetch(\`/api/admin/sites/\${siteId}/reorder\`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ direction })
        });
        if (!response.ok) throw new Error('移动网站失败');
        await loadSiteList();
        showAlert('success', '网站已成功' + (direction === 'up' ? '上移' : '下移'), 'siteAlert');
    } catch (error) {
        console.error('移动网站错误:', error);
        showAlert('danger', \`移动网站失败: \${error.message}\`, 'siteAlert');
    }
}

function showPasswordModal() {
    document.getElementById('passwordForm').reset();
    document.getElementById('passwordAlert').classList.add('d-none');
    new bootstrap.Modal(document.getElementById('passwordModal')).show();
}

async function changePassword() {
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    if (!currentPassword || !newPassword || !confirmPassword) {
        showPasswordAlert('danger', '所有密码字段都必须填写');
        return;
    }
    if (newPassword !== confirmPassword) {
        showPasswordAlert('danger', '新密码和确认密码不匹配');
        return;
    }
    try {
        const response = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
        });
        if (response.ok) {
            bootstrap.Modal.getInstance(document.getElementById('passwordModal')).hide();
            showAlert('success', '密码修改成功', 'serverAlert');
        } else {
            const data = await response.json();
            showPasswordAlert('danger', data.message || '密码修改失败');
        }
    } catch (error) {
        console.error('修改密码错误:', error);
        showPasswordAlert('danger', '密码修改请求失败，请稍后重试');
    }
}

function logout() {
    localStorage.removeItem('auth_token');
    window.location.href = 'login.html';
}

async function loadSiteList() {
    try {
        const response = await fetch('/api/admin/sites', { headers: getAuthHeaders() });
        if (!response.ok) throw new Error('获取监控网站列表失败');
        const data = await response.json();
        siteList = data.sites || [];
        renderSiteTable(siteList);
    } catch (error) {
        console.error('加载监控网站列表错误:', error);
        showAlert('danger', \`加载监控网站列表失败: \${error.message}\`, 'siteAlert');
    }
}

function renderSiteTable(sites) {
    const tableBody = document.getElementById('siteTableBody');
    tableBody.innerHTML = '';
    if (sites.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="10" class="text-center">暂无监控网站</td></tr>';
        return;
    }
    sites.forEach((site, index) => {
        const row = document.createElement('tr');
        const statusInfo = getSiteStatusBadge(site.last_status);
        const lastCheckTime = site.last_checked ? new Date(site.last_checked * 1000).toLocaleString() : '从未';
        const responseTime = site.last_response_time_ms !== null ? \`\${site.last_response_time_ms} ms\` : '-';
        row.innerHTML = \`
             <td>
                 <div class="btn-group btn-group-sm">
                     <button class="btn btn-outline-secondary move-site-btn" data-id="\${site.id}" data-direction="up" \${index === 0 ? 'disabled' : ''} title="上移"><i class="bi bi-arrow-up"></i></button>
                     <button class="btn btn-outline-secondary move-site-btn" data-id="\${site.id}" data-direction="down" \${index === sites.length - 1 ? 'disabled' : ''} title="下移"><i class="bi bi-arrow-down"></i></button>
                </div>
            </td>
            <td>\${site.name || '-'}</td>
            <td><a href="\${site.url}" target="_blank" rel="noopener noreferrer">\${site.url}</a></td>
            <td><span class="badge \${statusInfo.class}">\${statusInfo.text}</span></td>
            <td>\${site.last_status_code || '-'}</td>
            <td>\${responseTime}</td>
            <td>\${lastCheckTime}</td>
            <td>
                <div class="btn-group">
                    <button class="btn btn-sm btn-outline-primary edit-site-btn" data-id="\${site.id}" title="编辑"><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-sm btn-outline-danger delete-site-btn" data-id="\${site.id}" data-name="\${site.name || site.url}" data-url="\${site.url}" title="删除"><i class="bi bi-trash"></i></button>
                </div>
            </td>
        \`;
        tableBody.appendChild(row);
    });
    document.querySelectorAll('.edit-site-btn').forEach(btn => btn.addEventListener('click', function() { editSite(this.getAttribute('data-id')); }));
    document.querySelectorAll('.delete-site-btn').forEach(btn => btn.addEventListener('click', function() { showDeleteSiteConfirmation(this.getAttribute('data-id'), this.getAttribute('data-name'), this.getAttribute('data-url')); }));
    document.querySelectorAll('.move-site-btn').forEach(btn => btn.addEventListener('click', function() { moveSite(this.getAttribute('data-id'), this.getAttribute('data-direction')); }));
}

function getSiteStatusBadge(status) {
    switch (status) {
        case 'UP': return { class: 'bg-success', text: '正常' };
        case 'DOWN': return { class: 'bg-danger', text: '故障' };
        case 'TIMEOUT': return { class: 'bg-warning text-dark', text: '超时' };
        case 'ERROR': return { class: 'bg-danger', text: '错误' };
        case 'PENDING': return { class: 'bg-secondary', text: '待检测' };
        default: return { class: 'bg-secondary', text: '未知' };
    }
}

function showSiteModal(siteIdToEdit = null) {
    document.getElementById('siteForm').reset();
    const modalTitle = document.getElementById('siteModalTitle');
    const siteIdInput = document.getElementById('siteId');
    if (siteIdToEdit) {
        const site = siteList.find(s => s.id === siteIdToEdit);
        if (site) {
            modalTitle.textContent = '编辑监控网站';
            siteIdInput.value = site.id;
            document.getElementById('siteName').value = site.name || '';
            document.getElementById('siteUrl').value = site.url;
        } else {
            showAlert('danger', '未找到要编辑的网站信息。', 'siteAlert');
            return;
        }
    } else {
        modalTitle.textContent = '添加监控网站';
        siteIdInput.value = '';
    }
    new bootstrap.Modal(document.getElementById('siteModal')).show();
}

function editSite(siteId) {
    showSiteModal(siteId);
}

async function saveSite() {
    const siteId = document.getElementById('siteId').value;
    const siteName = document.getElementById('siteName').value.trim();
    const siteUrl = document.getElementById('siteUrl').value.trim();
    if (!siteUrl) {
        showAlert('warning', '请输入网站URL', 'siteAlert');
        return;
    }
    if (!siteUrl.startsWith('http://') && !siteUrl.startsWith('https://')) {
         showAlert('warning', 'URL必须以 http:// 或 https:// 开头', 'siteAlert');
        return;
    }
    const requestBody = { url: siteUrl, name: siteName };
    let apiUrl = '/api/admin/sites';
    let method = 'POST';
    if (siteId) {
        apiUrl = \`/api/admin/sites/\${siteId}\`;
        method = 'PUT';
    }
    try {
        const response = await fetch(apiUrl, {
            method: method,
            headers: getAuthHeaders(),
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) throw new Error(\`\${siteId ? '更新' : '添加'}网站失败\`);
        bootstrap.Modal.getInstance(document.getElementById('siteModal')).hide();
        await loadSiteList();
        showAlert('success', \`监控网站\${siteId ? '更新' : '添加'}成功\`, 'siteAlert');
    } catch (error) {
        console.error('保存网站错误:', error);
        showAlert('danger', \`保存网站失败: \${error.message}\`, 'siteAlert');
    }
}

function showDeleteSiteConfirmation(siteId, siteName, siteUrl) {
    currentSiteId = siteId;
    document.getElementById('deleteSiteName').textContent = siteName;
    document.getElementById('deleteSiteUrl').textContent = siteUrl;
    new bootstrap.Modal(document.getElementById('deleteSiteModal')).show();
}

async function deleteSite(siteId) {
    try {
        const response = await fetch(\`/api/admin/sites/\${siteId}\`, { method: 'DELETE', headers: getAuthHeaders() });
        if (!response.ok) throw new Error('删除网站失败');
        bootstrap.Modal.getInstance(document.getElementById('deleteSiteModal')).hide();
        await loadSiteList();
        showAlert('success', '网站监控已删除', 'siteAlert');
        currentSiteId = null;
    } catch (error) {
        console.error('删除网站错误:', error);
        showAlert('danger', \`删除网站失败: \${error.message}\`, 'siteAlert');
    }
}

function showAlert(type, message, alertId = 'serverAlert') {
    const alertElement = document.getElementById(alertId);
    if (!alertElement) return;
    alertElement.className = \`alert alert-\${type}\`;
    alertElement.textContent = message;
    alertElement.classList.remove('d-none');
    setTimeout(() => {
        alertElement.classList.add('d-none');
    }, 5000);
}

function showPasswordAlert(type, message) {
    const alertElement = document.getElementById('passwordAlert');
    if (!alertElement) return;
    alertElement.className = \`alert alert-\${type}\`;
    alertElement.textContent = message;
    alertElement.classList.remove('d-none');
}

async function loadTelegramSettings() {
    try {
        const response = await fetch('/api/admin/telegram-settings', { headers: getAuthHeaders() });
        if (!response.ok) throw new Error('获取Telegram设置失败');
        const settings = await response.json();
        if (settings) {
            document.getElementById('telegramBotToken').value = settings.bot_token || '';
            document.getElementById('telegramChatId').value = settings.chat_id || '';
            document.getElementById('enableTelegramNotifications').checked = !!settings.enable_notifications;
        }
    } catch (error) {
        console.error('加载Telegram设置错误:', error);
        showAlert('danger', \`加载Telegram设置失败: \${error.message}\`, 'telegramSettingsAlert');
    }
}

async function saveTelegramSettings() {
    const botToken = document.getElementById('telegramBotToken').value.trim();
    const chatId = document.getElementById('telegramChatId').value.trim();
    let enableNotifications = document.getElementById('enableTelegramNotifications').checked;

    if (!botToken || !chatId) {
        enableNotifications = false;
        document.getElementById('enableTelegramNotifications').checked = false;
        if (document.getElementById('enableTelegramNotifications').checked && (botToken || chatId)) {
             showAlert('warning', 'Bot Token 和 Chat ID 均不能为空才能启用通知。通知已自动禁用。', 'telegramSettingsAlert');
        }
    }

    try {
        const response = await fetch('/api/admin/telegram-settings', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                bot_token: botToken,
                chat_id: chatId,
                enable_notifications: enableNotifications
            })
        });
        if (!response.ok) throw new Error('保存Telegram设置失败');
        showAlert('success', 'Telegram设置已成功保存。', 'telegramSettingsAlert');
    } catch (error) {
        console.error('保存Telegram设置错误:', error);
        showAlert('danger', \`保存Telegram设置失败: \${error.message}\`, 'telegramSettingsAlert');
    }
}

async function loadGlobalSettings() {
    try {
        const response = await fetch('/api/admin/settings/vps-report-interval', { headers: getAuthHeaders() });
        if (!response.ok) throw new Error('获取VPS报告间隔失败');
        const settings = await response.json();
        if (settings && typeof settings.interval === 'number') {
            document.getElementById('vpsReportInterval').value = settings.interval;
        } else {
            document.getElementById('vpsReportInterval').value = 60;
        }
    } catch (error) {
        console.error('加载VPS报告间隔错误:', error);
        showAlert('danger', \`加载VPS报告间隔失败: \${error.message}\`, 'serverAlert');
        document.getElementById('vpsReportInterval').value = 60;
    }
}

async function saveVpsReportInterval() {
    const intervalInput = document.getElementById('vpsReportInterval');
    const interval = parseInt(intervalInput.value, 10);
    if (isNaN(interval) || interval < 1) {
        showAlert('warning', 'VPS报告间隔必须是一个大于或等于1的数字。', 'serverAlert');
        return;
    }
    try {
        const response = await fetch('/api/admin/settings/vps-report-interval', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ interval: interval })
        });
        if (!response.ok) throw new Error('保存VPS报告间隔失败');
        showAlert('success', 'VPS数据更新频率已成功保存。', 'serverAlert');
    } catch (error) {
        console.error('保存VPS报告间隔错误:', error);
        showAlert('danger', \`保存VPS报告间隔失败: \${error.message}\`, 'serverAlert');
    }
}`;
}
