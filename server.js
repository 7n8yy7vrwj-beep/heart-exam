const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

// 确保目录存在
if (!fs.existsSync('public')) fs.mkdirSync('public');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// 存储配置
let examConfig = {
  order: ["二尖瓣区", "肺动脉瓣区", "主动脉瓣区", "主动脉瓣第二听诊区", "三尖瓣区"],
  regionPositions: {}
};
let submissions = [];

// ---------- API 路由 ----------
app.post('/upload_template', upload.single('template'), (req, res) => {
  const targetPath = path.join(__dirname, 'public', 'template.jpg');
  fs.renameSync(req.file.path, targetPath);
  res.json({ status: 'ok', url: '/template.jpg' });
});

app.post('/save_regions', (req, res) => {
  examConfig.regionPositions = req.body.regions;
  fs.writeFileSync('config.json', JSON.stringify(examConfig));
  res.json({ status: 'ok' });
});

app.get('/get_config', (req, res) => {
  const templateUrl = fs.existsSync(path.join(__dirname, 'public', 'template.jpg')) ? '/template.jpg' : null;
  res.json({
    order: examConfig.order,
    regionPositions: examConfig.regionPositions,
    templateUrl
  });
});

app.post('/submit_exam', upload.single('video'), (req, res) => {
  const { studentName, report } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No video' });
  const videoPath = `/uploads/${req.file.filename}`;
  submissions.unshift({
    id: Date.now(),
    studentName: studentName || '匿名',
    timestamp: new Date().toISOString(),
    report: JSON.parse(report || '{}'),
    videoPath
  });
  res.json({ status: 'ok' });
});

app.get('/get_submissions', (req, res) => {
  res.json(submissions);
});

// ---------- WebSocket 信令 ----------
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });
const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('teacher-join', (roomName) => {
    socket.join(roomName);
    rooms.set(roomName, { teacherId: socket.id, students: new Set() });
  });
  socket.on('student-join', (roomName) => {
    socket.join(roomName);
    const room = rooms.get(roomName);
    if (room) {
      room.students.add(socket.id);
      io.to(room.teacherId).emit('new-student', socket.id);
    }
  });
  socket.on('offer', (data) => {
    io.to(data.target).emit('offer', { from: socket.id, offer: data.offer });
  });
  socket.on('answer', (data) => {
    io.to(data.target).emit('answer', { from: socket.id, answer: data.answer });
  });
  socket.on('ice-candidate', (data) => {
    io.to(data.target).emit('ice-candidate', { from: socket.id, candidate: data.candidate });
  });
  socket.on('disconnect', () => {
    for (let [roomName, room] of rooms.entries()) {
      if (room.teacherId === socket.id) rooms.delete(roomName);
      else if (room.students.has(socket.id)) {
        room.students.delete(socket.id);
        io.to(room.teacherId).emit('student-left', socket.id);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
