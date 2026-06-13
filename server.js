const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

// 配置文件上传
const upload = multer({ dest: 'uploads/' });

// 确保 public 目录存在
if (!fs.existsSync('public')) fs.mkdirSync('public');

// ========== 配置存储 ==========
let examConfig = {
  order: ["二尖瓣区", "肺动脉瓣区", "主动脉瓣区", "主动脉瓣第二听诊区", "三尖瓣区"],
  regionPositions: {}   // 教师标注的5个区域坐标（在模板图上）
};

const studentProgress = new Map();
let allRecords = [];

// ========== API ==========
// 教师端上传模板图
app.post('/upload_template', upload.single('template'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有文件' });
  const targetPath = path.join(__dirname, 'public', 'template.jpg');
  fs.renameSync(req.file.path, targetPath);
  res.json({ status: 'ok', url: '/template.jpg' });
});

// 提供模板图下载
app.get('/template.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'template.jpg'));
});

// 保存听诊区位置
app.post('/save_regions', (req, res) => {
  examConfig.regionPositions = req.body.regions;
  // 可选：持久化到文件
  fs.writeFileSync('config.json', JSON.stringify(examConfig));
  res.json({ status: 'ok' });
});

// 获取配置（顺序、区域坐标、模板图地址）
app.get('/get_config', (req, res) => {
  // 检查模板图是否存在
  const templateUrl = fs.existsSync(path.join(__dirname, 'public', 'template.jpg')) ? '/template.jpg' : null;
  res.json({
    order: examConfig.order,
    regionPositions: examConfig.regionPositions,
    templateUrl: templateUrl
  });
});

// 教师端页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teacher.html'));
});

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

// ========== Socket.IO 事件 ==========
io.on('connection', (socket) => {
  console.log('新连接:', socket.id);

  socket.on('student_register', (data) => {
    const studentId = data.student_id;
    studentProgress.set(studentId, {
      currentStep: 0,
      completed: [],
      stepTimes: [],
      startTime: null
    });
    socket.emit('registered', { studentId });
  });

  socket.on('student_start', (data) => {
    const studentId = data.student_id;
    const prog = studentProgress.get(studentId);
    if (prog) {
      prog.currentStep = 0;
      prog.completed = [];
      prog.stepTimes = [];
      prog.startTime = Date.now();
    }
    io.emit('student_status', { studentId, status: 'started' });
  });

  socket.on('student_ai_result', (data) => {
    const { studentId, result } = data;
    const prog = studentProgress.get(studentId);
    if (prog && result.stepCompleted) {
      const expected = examConfig.order[prog.currentStep];
      if (expected === result.detectedRegion) {
        prog.completed.push(expected);
        prog.stepTimes.push({
          step: prog.currentStep + 1,
          region: expected,
          timestamp: new Date().toLocaleTimeString()
        });
        prog.currentStep++;
      }
    }
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
    allRecords.push({
      studentId: studentId.slice(-6),
      time: new Date().toLocaleTimeString(),
      message: result.message,
      progress: `${prog?.completed.length || 0}/${examConfig.order.length}`
    });
  });

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
  
  socket.on('teacher_get_records', () => {
    socket.emit('all_records', allRecords);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器运行在 http://0.0.0.0:${PORT}`);
});
