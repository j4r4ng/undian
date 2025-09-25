const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const ejs = require('ejs');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = 3000;

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const db = new sqlite3.Database('undian.db', (err) => {
    if (err) {
        console.error("Error connecting to database:", err.message);
    } else {
        console.log("Connected to the undian.db database.");
        db.run(`CREATE TABLE IF NOT EXISTS peserta (
            no_undian INTEGER PRIMARY KEY,
            nama TEXT NOT NULL,
            rt TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'valid'
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS pemenang (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            no_undian INTEGER,
            nama TEXT,
            rt TEXT,
            hadiah TEXT
        )`);
    }
});

app.get('/', (req, res) => {
    res.render('index');
});

app.get('/admin', (req, res) => {
    db.all("SELECT * FROM peserta", [], (err, peserta) => {
        if (err) {
            return res.status(500).send("Error fetching participants for admin.");
        }
        db.all("SELECT * FROM pemenang", [], (err, pemenang) => {
            if (err) {
                return res.status(500).send("Error fetching winners for admin.");
            }
            res.render('admin', { peserta: peserta, pemenang: pemenang });
        });
    });
});

app.get('/admin/peserta', (req, res) => {
    const { rt, nama, status } = req.query;
    let sql = "SELECT * FROM peserta WHERE 1=1";
    let params = [];
    if (rt) {
        sql += " AND rt = ?";
        params.push(rt);
    }
    if (nama) {
        sql += " AND nama LIKE ?";
        params.push(`%${nama}%`);
    }
    if (status && (status === 'menang' || status === 'valid')) {
        sql += " AND status = ?";
        params.push(status);
    }
    sql += " ORDER BY no_undian ASC";
    db.all(sql, params, (err, peserta) => {
        if (err) {
            res.status(500).send("Error fetching participants with filters.");
        } else {
            res.render('edit_participants', { peserta: peserta, filter: req.query });
        }
    });
});

app.post('/api/peserta/update', (req, res) => {
    const { no_undian, nama, rt, status } = req.body;
    db.run("UPDATE peserta SET nama = ?, rt = ?, status = ? WHERE no_undian = ?", 
        [nama, rt, status, no_undian], function(err) {
        if (err) {
            res.json({ status: 'error', message: err.message });
        } else {
            res.json({ status: 'success' });
        }
    });
});

app.post('/api/peserta/delete', (req, res) => {
    const { no_undian } = req.body;
    db.run("DELETE FROM peserta WHERE no_undian = ?", no_undian, function(err) {
        if (err) {
            res.json({ status: 'error', message: err.message });
        } else {
            res.json({ status: 'success' });
        }
    });
});

app.post('/api/peserta/delete/bulk', (req, res) => {
    const { no_undians } = req.body;
    if (!Array.isArray(no_undians) || no_undians.length === 0) {
        return res.status(400).json({ status: 'error', message: 'Tidak ada peserta yang dipilih untuk dihapus.' });
    }
    const placeholders = no_undians.map(() => '?').join(',');
    const sql = `DELETE FROM peserta WHERE no_undian IN (${placeholders})`;
    db.run(sql, no_undians, function(err) {
        if (err) {
            res.json({ status: 'error', message: err.message });
        } else {
            res.json({ status: 'success', message: `Berhasil menghapus ${this.changes} peserta.` });
        }
    });
});

app.post('/api/peserta/add', (req, res) => {
    const { no_undian, nama, rt } = req.body;
    db.run("INSERT INTO peserta (no_undian, nama, rt) VALUES (?, ?, ?)", 
        [no_undian, nama, rt], function(err) {
        if (err) {
            res.json({ status: 'error', message: err.message });
        } else {
            res.json({ status: 'success' });
        }
    });
});

app.post('/api/peserta/add/bulk', (req, res) => {
    const { data } = req.body;
    const entries = data.split('\n').filter(line => line.trim() !== '');
    db.serialize(() => {
        db.run("BEGIN TRANSACTION;");
        const stmt = db.prepare("INSERT INTO peserta (no_undian, nama, rt) VALUES (?, ?, ?)");
        let successCount = 0;
        let errorCount = 0;
        for (const line of entries) {
            const parts = line.split(',').map(part => part.trim());
            if (parts.length === 3) {
                const [no_undian, nama, rt] = parts;
                stmt.run(no_undian, nama, rt, function(err) {
                    if (err) {
                        errorCount++;
                    } else {
                        successCount++;
                    }
                });
            } else {
                errorCount++;
            }
        }
        stmt.finalize(() => {
            db.run("COMMIT;", function(err) {
                if (err) {
                    res.json({ status: 'error', message: "Transaction failed." });
                } else {
                    res.json({ 
                        status: 'success', 
                        message: `${successCount} peserta berhasil ditambahkan, ${errorCount} gagal.` 
                    });
                }
            });
        });
    });
});

app.post('/api/peserta/add/excel', upload.single('excelFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ status: 'error', message: 'Tidak ada file yang diunggah.' });
        }
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = xlsx.utils.sheet_to_json(sheet);
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");
            const stmt = db.prepare("INSERT INTO peserta (no_undian, nama, rt) VALUES (?, ?, ?)");
            let successCount = 0;
            let errorCount = 0;
            jsonData.forEach(row => {
                const { no_undian, nama, rt } = row;
                if (no_undian && nama && rt) {
                    stmt.run(no_undian, nama, rt, function(err) {
                        if (err) {
                            errorCount++;
                        } else {
                            successCount++;
                        }
                    });
                } else {
                    errorCount++;
                }
            });
            stmt.finalize(() => {
                db.run("COMMIT;", function(err) {
                    if (err) {
                        res.json({ status: 'error', message: "Transaction failed." });
                    } else {
                        res.json({ status: 'success', message: `${successCount} peserta berhasil ditambahkan, ${errorCount} gagal.` });
                    }
                });
            });
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: 'error', message: 'Gagal memproses file Excel.' });
    }
});

app.post('/api/peserta/update/bulk', (req, res) => {
    const { no_undians, new_status } = req.body;
    if (!Array.isArray(no_undians) || no_undians.length === 0 || !new_status) {
        return res.status(400).json({ status: 'error', message: 'Data tidak lengkap.' });
    }
    const placeholders = no_undians.map(() => '?').join(',');
    const sql = `UPDATE peserta SET status = ? WHERE no_undian IN (${placeholders})`;
    const params = [new_status, ...no_undians];
    db.run(sql, params, function(err) {
        if (err) {
            res.json({ status: 'error', message: err.message });
        } else {
            res.json({ status: 'success', message: `Berhasil mengubah status ${this.changes} peserta menjadi ${new_status}.` });
        }
    });
});

io.on('connection', (socket) => {
    console.log('Client connected via socket');
    db.all("SELECT no_undian, nama, rt, status FROM peserta WHERE status = 'valid'", [], (err, participants) => {
        if (err) {
            console.error("Error fetching participants for client:", err);
            return;
        }
        socket.emit('raffleParticipants', participants);
    });

    socket.on('startDraw', (data) => {
        const { prizeName, numberOfWinners, duration } = data;
        const jumlahPemenang = parseInt(numberOfWinners);
        db.all("SELECT * FROM peserta WHERE status = 'valid'", [], (err, pesertaValid) => {
            if (err) {
                console.error("Error fetching valid participants:", err);
                return;
            }
            if (pesertaValid.length < jumlahPemenang) {
                const msg = `Jumlah peserta (${pesertaValid.length}) kurang dari jumlah pemenang (${jumlahPemenang})!`;
                io.emit('raffleError', { message: msg });
                return;
            }
            io.emit('startRaffleAnimation', { prizeName });
            setTimeout(() => {
                const pemenang = [];
                const pesertaYangDipilih = new Set();
                while (pemenang.length < jumlahPemenang) {
                    const randomIndex = Math.floor(Math.random() * pesertaValid.length);
                    const calonPemenang = pesertaValid[randomIndex];
                    if (!pesertaYangDipilih.has(calonPemenang.no_undian)) {
                        pemenang.push(calonPemenang);
                        pesertaYangDipilih.add(calonPemenang.no_undian);
                    }
                }
                if (pemenang.length > 0) {
                    const stmt = db.prepare("UPDATE peserta SET status = 'menang' WHERE no_undian = ?");
                    pemenang.forEach(p => {
                        stmt.run(p.no_undian);
                    });
                    stmt.finalize();
                    
                    pemenang.forEach(p => {
                        db.run("INSERT INTO pemenang (no_undian, nama, rt, hadiah) VALUES (?, ?, ?, ?)", [p.no_undian, p.nama, p.rt, prizeName]);
                    });
                    io.emit('raffleWinner', { winners: pemenang });
                }
            }, duration);
        });
    });
});

server.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});