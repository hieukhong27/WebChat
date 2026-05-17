const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path'); 

const app = express();
app.use(cors());
app.use(express.json());

// 📁 CHUẨN HÓA VERCEL: Phục vụ file giao diện tĩnh trực tiếp từ thư mục gốc đám mây
app.use(express.static(__dirname));

// 🎯 CHUẨN HÓA VERCEL: Định tuyến mặc định gửi file login.html khi người dùng truy cập link tên miền .vercel.app
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 🍃 CHUẨN HÓA DATABASE: Kết nối cụm MongoDB Atlas (Đọc trực tiếp từ Environment Variables bảo mật của Vercel)
const MONGO_URI = process.env.MONGODB_URI || "mongodb+srv://hieuhieu27306_db_user:AcQJoWR8rUViXVk@webchat.ivx7oic.mongodb.net/zalo_clone_db?retryWrites=true&w=majority&appName=WebChat"; 
mongoose.connect(MONGO_URI)
    .then(() => console.log("🍃 Đã kết nối MongoDB Atlas thành công!"))
    .catch(err => console.error("❌ Lỗi kết nối MongoDB:", err));

// ==========================================
// ĐỊNH NGHĨA SCHEMAS & MODELS
// ==========================================
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], 
    friendRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] 
});
const User = mongoose.model('User', userSchema);

const roomSchema = new mongoose.Schema({
    name: { type: String, default: "Cuộc trò chuyện" },
    type: { type: String, enum: ['direct', 'channel', 'group'], required: true },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
});
const Room = mongoose.model('Room', roomSchema);

const messageSchema = new mongoose.Schema({
    roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    senderName: String,
    text: String,
    time: String
});
const Message = mongoose.model('Message', messageSchema);

// ==========================================
// HTTP API XỬ LÝ ĐĂNG KÝ / ĐĂNG NHẬP / TẠO PHÒNG
// ==========================================
app.post('/api/register', async (req, res) => {
    const { name, username, password } = req.body;
    if (!name || !username || !password) return res.status(400).json({ error: "Vui lòng điền đủ thông tin!" });

    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: "Tên đăng nhập đã tồn tại!" });

        const newUser = new User({ name, username, password });
        await newUser.save();
        
        await broadcastUserList();
        res.json({ id: newUser._id, name: newUser.name, username: newUser.username });
    } catch (err) {
        res.status(500).json({ error: "Lỗi hệ thống đăng ký!" });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username, password });
        if (!user) return res.status(400).json({ error: "Tài khoản hoặc mật khẩu sai!" });
        res.json({ id: user._id, name: user.name, username: user.username });
    } catch (err) {
        res.status(500).json({ error: "Lỗi hệ thống đăng nhập!" });
    }
});

app.post('/api/rooms', async (req, res) => {
    const { roomName, type, creatorId, members } = req.body;
    try {
        const allMembers = [...members, creatorId];
        const newRoom = new Room({ name: roomName || "Cuộc trò chuyện mới", type, members: allMembers, adminId: creatorId });
        await newRoom.save();

        await broadcastRoomList();
        res.json(newRoom);
    } catch (err) {
        res.status(500).json({ error: "Lỗi tạo phòng!" });
    }
});

async function broadcastUserList() {
    const allUsers = await User.find({}, 'name username');
    io.emit('update_user_list', allUsers.map(u => ({ id: u._id, name: u.name, username: u.username })));
}

async function broadcastRoomList() {
    const allRooms = await Room.find({});
    io.emit('update_room_list', allRooms.map(r => ({
        id: r._id, name: r.name, type: r.type,
        members: r.members.map(m => m.toString()),
        adminId: r.adminId.toString()
    })));
}

async function sendFriendData(userId) {
    try {
        const user = await User.findById(userId)
            .populate('friends', 'name username')
            .populate('friendRequests', 'name username');
        
        if (!user) return;

        const sockets = await io.fetchSockets();
        const userSocket = sockets.find(s => s.userId === userId.toString());
        
        if (userSocket) {
            userSocket.emit('update_friend_data', {
                friends: user.friends.map(f => ({ id: f._id, name: f.name, username: f.username })),
                requests: user.friendRequests.map(r => ({ id: r._id, name: r.name, username: r.username }))
            });
        }
    } catch (err) {
        console.error(err);
    }
}

// ==========================================
// SOCKET.IO REAL-TIME CHAT, KẾT BẠN & GỌI VIDEO
// ==========================================
io.on('connection', async (socket) => {
    
    socket.on('join_room', async ({ userId, roomId }) => {
        socket.userId = userId;
        
        const dbUsers = await User.find({}, 'name username');
        socket.emit('update_user_list', dbUsers.map(u => ({ id: u._id, name: u.name, username: u.username })));
        
        const dbRooms = await Room.find({});
        socket.emit('update_room_list', dbRooms.map(r => ({
            id: r._id, name: r.name, type: r.type,
            members: r.members.map(m => m.toString()),
            adminId: r.adminId.toString()
        })));

        await sendFriendData(userId);

        if (roomId) {
            const room = await Room.findById(roomId);
            if (room && room.members.includes(userId)) {
                socket.join(roomId);
                
                const oldMessages = await Message.find({ roomId }).sort({ _id: 1 });
                socket.emit('clear_chat_screen');
                oldMessages.forEach(msg => {
                    socket.emit('receive_message', { senderName: msg.senderName, text: msg.text, time: msg.time });
                });
            }
        }
    });

    socket.on('send_friend_request', async ({ senderId, targetUsername }) => {
        try {
            const targetUser = await User.findOne({ username: targetUsername });
            if (!targetUser) return socket.emit('error_message', '❌ Không tìm thấy người dùng này!');
            if (targetUser._id.toString() === senderId) return socket.emit('error_message', '❌ Bạn không thể tự kết bạn với chính mình!');
            if (targetUser.friendRequests.includes(senderId) || targetUser.friends.includes(senderId)) {
                return socket.emit('error_message', '⚠️ Đã gửi lời mời hoặc hai người đã là bạn bè!');
            }

            targetUser.friendRequests.push(senderId);
            await targetUser.save();

            socket.emit('friend_success_msg', '✅ Đã gửi lời mời kết bạn thành công!');
            await sendFriendData(targetUser._id);
        } catch (err) {
            socket.emit('error_message', 'Lỗi xử lý gửi kết bạn');
        }
    });

    socket.on('accept_friend_request', async ({ userId, requesterId }) => {
        try {
            const user = await User.findById(userId);
            const requester = await User.findById(requesterId);

            if (!user || !requester) return;

            user.friendRequests = user.friendRequests.filter(id => id.toString() !== requesterId);
            
            if (!user.friends.includes(requesterId)) user.friends.push(requesterId);
            if (!requester.friends.includes(userId)) requester.friends.push(userId);

            await user.save();
            await requester.save();

            await sendFriendData(userId);
            await sendFriendData(requesterId);
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('decline_friend_request', async ({ userId, requesterId }) => {
        try {
            const user = await User.findById(userId);
            if (!user) return;

            user.friendRequests = user.friendRequests.filter(id => id.toString() !== requesterId);
            await user.save();

            await sendFriendData(userId);
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('send_message', async ({ roomId, messageText }) => {
        try {
            const room = await Room.findById(roomId);
            const user = await User.findById(socket.userId);
            if (!room || !user) return;

            if (room.type === "channel" && room.adminId.toString() !== socket.userId) {
                return socket.emit('error_message', '❌ Chỉ Admin mới được nhắn tin ở kênh thông báo!');
            }

            const msgData = {
                senderName: user.name, text: messageText,
                time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
            };

            const newMessage = new Message({ roomId, senderId: socket.userId, senderName: user.name, text: messageText, time: msgData.time });
            await newMessage.save();

            io.to(roomId).emit('receive_message', msgData);
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('call_user', ({ targetRoomId, signalData, isVideo }) => {
        socket.to(targetRoomId).emit('incoming_call', {
            fromRoomId: targetRoomId,
            fromUserId: socket.userId,
            signalData: signalData, 
            isVideo: isVideo
        });
    });

    socket.on('accept_call', ({ targetRoomId, signalData }) => {
        socket.to(targetRoomId).emit('call_accepted', { signalData });
    });

    socket.on('reject_call', ({ targetRoomId }) => {
        socket.to(targetRoomId).emit('call_rejected');
    });

    socket.on('ice_candidate', ({ targetRoomId, candidate }) => {
        socket.to(targetRoomId).emit('ice_candidate', { candidate });
    });

    socket.on('end_call', ({ targetRoomId }) => {
        socket.to(targetRoomId).emit('call_ended');
    });
});

// 🌐 CỔNG CHẠY LINH HOẠT: Tự động lấy biến PORT của hệ thống đám mây Vercel cấp phát
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server Zalo đang vận hành ổn định tại cổng: ${PORT}`);
});
