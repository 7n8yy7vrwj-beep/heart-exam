const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teacher.html'));
});

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

// ========== 配置存储 ==========
let examConfig = {
  order: ["二尖瓣区", "肺动脉瓣区", "主动脉瓣区", "主动脉瓣第二听诊区", "三尖瓣区"],
  regionPositions: {}   // 教师标注的5个区域坐标 { "二尖瓣区": {x, y}, ... }
};

// 存储学生进度
const studentProgress = new Map();
// 存储所有考核记录
let allRecords = [];

// ========== API ==========
app.post('/save_order', (req, res) => {
  examConfig.order = req.body.order;
  res.json({ status: 'ok' });
});

app.post('/save_regions', (req, res) => {
  examConfig.regionPositions = req.body.regions;
  res.json({ status: 'ok' });
});

app.get('/get_config', (req, res) => {
  res.json({ order: examConfig.order, regionPositions: examConfig.regionPositions });
});

// ========== Socket.IO ==========
io.on('connection', (socket) => {
  console.log('新连接:', socket.id);

  // 学生注册
  socket.on('student_register', (data) => {
    const studentId = data.student_id;
    studentProgress.set(studentId, {
      currentStep: 0,
      completed: [],
      stepTimes: [],
      lastRegion: null,
      lastTime: null,
      startTime: null
    });
    socket.emit('registered', { studentId });
  });

  // 学生开始考核
  socket.on('student_start', (data) => {
    const studentId = data.student_id;
    const prog = studentProgress.get(studentId);
    if (prog) {
      prog.currentStep = 0;
      prog.completed = [];
      prog.stepTimes = [];
      prog.startTime = Date.now();
      prog.lastRegion = null;
      prog.lastTime = null;
    }
    io.emit('student_status', { studentId, status: 'started' });
  });

  // 学生上报AI分析结果（前端已经判断好了）
  socket.on('student_ai_result', (data) => {
    const { studentId, result } = data;
    // result = { detectedRegion, isCorrect, message, progress, stepCompleted, ... }
    
    // 更新学生进度（如果需要服务端也维护一份，与前端同步）
    const prog = studentProgress.get(studentId);
    if (prog && result.stepCompleted) {
      // 前端已经完成了某一步，服务端记录
      const expected = examConfig.order[prog.currentStep];
      if (expected === result.detectedRegion) {
        prog.completed.push(expected);
        prog.stepTimes.push({
          step: prog.currentStep + 1,
          region: expected,
          timestamp: new Date().toLocaleTimeString(),
          duration: result.duration || 2.0
        });
        prog.currentStep++;
      }
    }
    
    // 广播给所有教师端
    io.emit('ai_feedback', {
      studentId,
      result: {
        detectedRegion: result.detectedRegion,
        message: result.message,
        progress: `${prog?.completed.length || 0}/${examConfig.order.length}`,
        stepCompleted: result.stepCompleted || false
      },
      frame: result.frame || null
    });
    
    // 记录到总记录表
    allRecords.push({
      studentId: studentId.slice(-6),
      time: new Date().toLocaleTimeString(),
      message: result.message,
      progress: `${prog?.completed.length || 0}/${examConfig.order.length}`
    });
  });

  // 学生结束考核
  socket.on('student_end', (data) => {
    const studentId = data.student_id;
    const prog = studentProgress.get(studentId);
    const passed = prog?.completed.length === examConfig.order.length;
    io.emit('student_report', {
      studentId,
      report: {
        passed,
        completedSteps: prog?.completed || [],
        totalSteps: examConfig.order.length,
        suggestion: passed ? '完美通过' : '请加强练习'
      }
    });
  });

  // 教师端获取所有学生列表
  socket.on('teacher_get_students', () => {
    const list = [];
    for (let [id, prog] of studentProgress.entries()) {
      list.push({
        id: id.slice(-6),
        fullId: id,
        completed: prog.completed.length,
        total: examConfig.order.length,
        status: prog.startTime ? (prog.completed.length === examConfig.order.length ? '已完成' : '进行中') : '未开始'
      });
    }
    socket.emit('students_list', list);
  });
  
  // 教师端获取所有记录
  socket.on('teacher_get_records', () => {
    socket.emit('all_records', allRecords);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器运行在 http://0.0.0.0:${PORT}`);
});
