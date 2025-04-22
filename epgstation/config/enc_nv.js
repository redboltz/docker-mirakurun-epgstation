const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const axios = require('axios');

// ログファイルローリング（タイムスタンプ付き）
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const debugLogPath = `/app/logs/enc_nv_debug_${timestamp}.log`;
const writeDebug = (msg) => {
    fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`);
};

writeDebug('start');

const ffmpeg = process.env.FFMPEG;
const ffprobe = process.env.FFPROBE;
const input = process.env.INPUT;
const output = process.env.OUTPUT;
const description = process.env.DESCRIPTION || '';
const apiHost = process.env.EPGSTATION_API_HOST || 'http://localhost:8888';

const getRecordedInfo = async (id) => {
    try {
        const res = await axios.get(`${apiHost}/api/recorded/${id}?isHalfWidth=true`);
        return res.data;
    } catch (err) {
        writeDebug('[ERROR] Failed to fetch recorded info: ' + err.message);
        return null;
    }
};

const findRecordedIdByInput = async (inputPath, limit = 20) => {
    try {
        const res = await axios.get(`${apiHost}/api/recorded?limit=${limit}&isHalfWidth=true`);
        const basename = path.basename(inputPath);
        writeDebug(`[DEBUG] comparing input filename: "${basename}"`);
        if (!Array.isArray(res.data.records)) {
            writeDebug(`[ERROR] Unexpected API response: res.data.records is not an array: ${JSON.stringify(res.data)}`);
            return null;
        }
        for (const rec of res.data.records) {
            const recFilename = path.basename(rec.videoFiles?.[0]?.filename || '');
            writeDebug(`[DEBUG] candidate recorded.filename: "${recFilename}"`);
            if (recFilename === basename) {
                writeDebug(`[INFO] Matched input to recorded.id=${rec.id}`);
                return rec.id;
            }
        }
        writeDebug('[WARN] No matching recorded.id found for: ' + basename);
    } catch (err) {
        writeDebug('[ERROR] Failed to search recorded list: ' + err.message);
    }
    return null;
};

const detectAudioType = (recorded) => {
    const acType = recorded?.audioComponentType;
    writeDebug('[DEBUG] audioComponentType: ' + acType);

    switch (acType) {
        case 1: return 'mono';
        case 2: return 'dualmono';
        case 3: return 'stereo';
        case 9: return '5.1ch';
        default: return 'unknown';
    }
};

writeDebug('[DEBUG] description: ' + JSON.stringify(description));

if (!fs.existsSync(input)) {
    writeDebug('[ERROR] Input file does not exist: ' + input);
    process.exit(1);
} else {
    writeDebug('[INFO] Input file exists: ' + input);
}

const VIDEO_ENCODING_PARAMS = {
    rc: 'vbr_hq',
    cq: '25',
    bitrate: '5M',
    maxrate: '10M',
    bufsize: '15M',
    preset: 'p4',
    profile: 'high',
};

const getDuration = filePath => new Promise((resolve, reject) => {
    execFile(ffprobe, ['-v', '0', '-show_format', '-of', 'json', filePath], (err, stdout) => {
        if (err) return reject(err);
        try {
            const result = JSON.parse(stdout);
            resolve(parseFloat(result.format.duration));
        } catch (e) { reject(e); }
    });
});

const detect5_1StartTime = async filePath => {
    const tmpDir = 'recorded/tmp_audio_scan';
    fs.mkdirSync(tmpDir, { recursive: true });
    for (let i = 0; i <= 120; i += 2) {
        const tmpWav = path.join(tmpDir, `audio_${i}.wav`);
        await new Promise(resolve => {
            const proc = spawn(ffmpeg, [
                '-v', 'error', '-y',
                '-i', filePath,
                '-ss', `${i}`, '-t', '1',
                '-vn', '-acodec', 'pcm_s16le',
                '-ac', '6', '-f', 'wav',
                tmpWav
            ]);
            proc.on('exit', resolve);
        });
        const channels = await new Promise(resolve => {
            execFile(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'default=noprint_wrappers=1:nokey=1', tmpWav], (err, stdout) => {
                resolve(stdout.trim());
            });
        });
        writeDebug(`[CHECK] ${i}秒: ${channels}ch`);
        if (channels === '6') {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return i;
        }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return null;
};

(async () => {
    const duration = await getDuration(input);

    let recordedId = process.env.RECORDED_ID;
    if (!recordedId) {
        writeDebug('[INFO] RECORDED_ID not set, attempting to find via filename...');
        recordedId = await findRecordedIdByInput(input);
    }

    const recorded = await getRecordedInfo(recordedId);
    const audioType = detectAudioType(recorded);

    writeDebug('[DEBUG] recordedId: ' + recordedId);
    writeDebug('[DEBUG] audioType (from API): ' + audioType);

    let startTime = null;
    if (audioType === '5.1ch') {
        startTime = await detect5_1StartTime(input);
    }

    const args = ['-y'];
    if (startTime !== null) {
        writeDebug(`[INFO] 5.1ch detected. Starting at ${startTime} seconds.`);
        args.push('-ss', `${startTime}`);
    } else {
        writeDebug('[INFO] No 5.1ch detected. Using AAC stereo.');
    }

    args.push('-fix_sub_duration');
    args.push('-i', input);

    if (audioType === 'dualmono') {
        writeDebug('[INFO] Dual Mono detected. Splitting into 2 tracks.');
        const filter = "[0:a]channelsplit=channel_layout=stereo[left][right];" +
                       "[left]pan=mono|c0=FL[mono_left];" +
                       "[right]pan=mono|c0=FR[mono_right]";
        args.push('-filter_complex', filter);
        args.push('-map', '0:v:0', '-vf', 'yadif');
        args.push('-map', '[mono_left]', '-c:a:0', 'aac', '-b:a:0', '128k', '-metadata:s:a:0', 'language=jpn');
        args.push('-map', '[mono_right]', '-c:a:1', 'aac', '-b:a:1', '128k', '-metadata:s:a:1', 'language=eng');
        args.push('-c:v', 'h264_nvenc');
    } else if (audioType === '5.1ch' && startTime !== null) {
        args.push('-map', '0:v', '-c:v', 'h264_nvenc', '-vf', 'yadif');
        args.push('-map', '0:a:0', '-channel_layout', '5.1', '-c:a', 'ac3', '-b:a', '640k');
    } else {
        args.push('-map', '0:v', '-c:v', 'h264_nvenc', '-vf', 'yadif');
        args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k');
    }

    args.push('-map', '0:s?', '-c:s', 'mov_text');
    args.push('-rc:v', VIDEO_ENCODING_PARAMS.rc,
        '-cq:v', VIDEO_ENCODING_PARAMS.cq,
        '-b:v', VIDEO_ENCODING_PARAMS.bitrate,
        '-maxrate:v', VIDEO_ENCODING_PARAMS.maxrate,
        '-bufsize:v', VIDEO_ENCODING_PARAMS.bufsize,
        '-preset', VIDEO_ENCODING_PARAMS.preset,
        '-profile:v', VIDEO_ENCODING_PARAMS.profile);
    args.push(output);

    let child = spawn(ffmpeg, args);

    child.stderr.on('data', data => {
        const lines = String(data).split('\n');
        for (let line of lines) {
            // "progress" ログを出力しないように変更
        }
    });

    child.on('exit', (code, signal) => {
        if (code === 0) {
            writeDebug(`[DONE] ffmpeg exited cleanly: ${code}, signal: ${signal}`);
            writeDebug('finished');
            return;
        }

        writeDebug(`[WARN] ffmpeg failed (${code}). Trying fallback...`);
        const fallbackArgs = args.map(arg => arg === '-c:a' ? 'aac' : arg).filter(arg => arg !== '-bsf:a');

        const fallback = spawn(ffmpeg, fallbackArgs);
        fallback.stderr.on('data', d => writeDebug('[ffmpeg fallback stderr]', d.toString()));
        fallback.on('exit', (c, s) => writeDebug(`[DONE] fallback ffmpeg exited: ${c}, signal: ${s}`));
    });

    process.on('SIGINT', () => child.kill('SIGINT'));
})();
