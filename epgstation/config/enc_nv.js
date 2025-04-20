console.log('start');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const ffmpeg = process.env.FFMPEG;
const ffprobe = process.env.FFPROBE;
const input = process.env.INPUT;
const output = process.env.OUTPUT;
const isDualMono = parseInt(process.env.AUDIOCOMPONENTTYPE, 10) === 2;

if (!fs.existsSync(input)) {
    console.error('[ERROR] Input file does not exist:', input);
    process.exit(1);
} else {
    console.log('[INFO] Input file exists:', input);
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
        const tmpWav = `${tmpDir}/audio_${i}.wav`;
        await new Promise(resolve => {
            const proc = spawn(ffmpeg, ['-v', 'error', '-y', '-ss', `${i}`, '-t', '1', '-i', filePath, '-vn', '-acodec', 'pcm_s16le', '-ac', '6', '-f', 'wav', tmpWav]);
            proc.on('exit', resolve);
        });
        const channels = await new Promise(resolve => {
            execFile(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'default=noprint_wrappers=1:nokey=1', tmpWav], (err, stdout) => {
                resolve(stdout.trim());
            });
        });
        console.log(`[CHECK] ${i}•b: ${channels}ch`);
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
    const startTime = await detect5_1StartTime(input);

    const args = ['-y'];
    if (startTime !== null) {
        console.log(`[INFO] 5.1ch detected. Starting at ${startTime} seconds.`);
        args.push('-ss', `${startTime}`);
    } else {
        console.log('[INFO] 5.1ch not detected in first 2 minutes. Encoding from beginning.');
    }

    args.push('-fix_sub_duration');
    args.push('-i', input);
    args.push('-map', '0:v', '-c:v', 'h264_nvenc', '-vf', 'yadif');

    if (isDualMono) {
        args.push('-filter_complex', 'channelsplit[FL][FR]',
            '-map', '[FL]', '-map', '[FR]',
            '-metadata:s:a:0', 'language=jpn',
            '-metadata:s:a:1', 'language=eng',
            '-c:a', 'aac', '-b:a', '192k');
    } else if (startTime !== null) {
        args.push('-map', '0:a:0', '-channel_layout', '5.1', '-c:a', 'ac3', '-b:a', '640k');
    } else {
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
            if (line.startsWith('frame')) {
                const m = line.match(/frame=\s*(\d+).*time=(\d+):(\d+):(\d+\.\d+)/);
                if (m) {
                    const time = (+m[1] * 3600) + (+m[2] * 60) + parseFloat(m[3]);
                    const percent = duration ? time / duration : 0;
                    console.log(JSON.stringify({ type: 'progress', percent: percent, log: line.trim() }));
                }
            }
        }
    });

    child.on('exit', (code, signal) => {
        if (code === 0) {
            console.log(`[DONE] ffmpeg exited cleanly: ${code}, signal: ${signal}`);
            return;
        }

        console.error(`[WARN] ffmpeg failed (${code}). Trying fallback...`);
        const fallbackArgs = args.map(arg => arg === '-c:a' ? 'aac' : arg).filter(arg => arg !== '-bsf:a');

        const fallback = spawn(ffmpeg, fallbackArgs);
        fallback.stderr.on('data', d => console.error('[ffmpeg fallback stderr]', d.toString()));
        fallback.on('exit', (c, s) => console.log(`[DONE] fallback ffmpeg exited: ${c}, signal: ${s}`));
    });

    process.on('SIGINT', () => child.kill('SIGINT'));
})();
