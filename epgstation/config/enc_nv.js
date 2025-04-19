console.log('start')
const spawn = require('child_process').spawn;
const execFile = require('child_process').execFile;
const ffmpeg = process.env.FFMPEG;
const fs = require('fs');
const ffprobe = process.env.FFPROBE;

const input = process.env.INPUT;
const output = process.env.OUTPUT;
const isDualMono = parseInt(process.env.AUDIOCOMPONENTTYPE, 10) == 2;
if (!fs.existsSync(input)) {
    console.error('? Input file does not exist:', input);
    process.exit(1);
} else {
    console.log('? Input file exists:', input);
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

const args = ['-y'];

const getDuration = filePath => {
    return new Promise((resolve, reject) => {
        execFile(ffprobe, ['-v', '0', '-show_format', '-of', 'json', filePath], (err, stdout) => {
            if (err) {
                reject(err);
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(parseFloat(result.format.duration));
            } catch (err) {
                reject(err);
            }
        });
    });
};

const getAudioChannels = filePath => {
    return new Promise((resolve, reject) => {
        execFile(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'json', filePath], (err, stdout) => {
            if (err) {
                reject(err);
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(result.streams[0].channels);
            } catch (err) {
                reject(err);
            }
        });
    });
};

(async () => {
    const duration = await getDuration(input);
    const channels = await getAudioChannels(input);

    Array.prototype.push.apply(args, ['-fix_sub_duration']);
    Array.prototype.push.apply(args, ['-i', input]);
    Array.prototype.push.apply(args, ['-map', '0:v', '-c:v', 'h264_nvenc']);
    Array.prototype.push.apply(args, ['-vf', 'yadif']);

    if (isDualMono) {
        args.push(
            '-filter_complex',
            'channelsplit[FL][FR]',
            '-map', '[FL]',
            '-map', '[FR]',
            '-metadata:s:a:0', 'language=jpn',
            '-metadata:s:a:1', 'language=eng',
            '-c:a', 'aac',
            '-b:a', '192k'
        );
    } else if (channels >= 6) {
        args.push('-map', '0:a:0', '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc');
    } else {
        args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k');
    }

    Array.prototype.push.apply(args, ['-map', '0:s?', '-c:s', 'mov_text']);
    Array.prototype.push.apply(args, [
        '-rc:v', VIDEO_ENCODING_PARAMS.rc,
        '-cq:v', VIDEO_ENCODING_PARAMS.cq,
        '-b:v', VIDEO_ENCODING_PARAMS.bitrate,
        '-maxrate:v', VIDEO_ENCODING_PARAMS.maxrate,
        '-bufsize:v', VIDEO_ENCODING_PARAMS.bufsize,
        '-preset', VIDEO_ENCODING_PARAMS.preset,
        '-profile:v', VIDEO_ENCODING_PARAMS.profile
    ]);
    Array.prototype.push.apply(args, [output]);

    let child = spawn(ffmpeg, args);

    child.stderr.on('data', data => {
        console.error('[ffmpeg stderr]', data.toString());
    });

    child.stderr.on('data', data => {
        let strbyline = String(data).split('\n');
        for (let i = 0; i < strbyline.length; i++) {
            let str = strbyline[i];
            if (str.startsWith('frame')) {
                const progress = {};
                const ffmpeg_reg = /frame=\s*(?<frame>\d+)\sfps=\s*(?<fps>\d+(?:\.\d+)?)\sq=\s*(?<q>[+-]?\d+(?:\.\d+)?)\sL?size=\s*(?<size>\d+(?:\.\d+)?)kB\stime=\s*(?<time>\d+[:\.\d+]*)\sbitrate=\s*(?<bitrate>\d+(?:\.\d+)?)kbits\/s(?:\sdup=\s*(?<dup>\d+))?(?:\sdrop=\s*(?<drop>\d+))?\sspeed=\s*(?<speed>\d+(?:\.\d+)?)x/;
                let ffmatch = str.match(ffmpeg_reg);
                if (ffmatch === null) continue;
                progress['frame'] = parseInt(ffmatch.groups.frame);
                progress['fps'] = parseFloat(ffmatch.groups.fps);
                progress['q'] = parseFloat(ffmatch.groups.q);
                progress['size'] = parseInt(ffmatch.groups.size);
                progress['time'] = ffmatch.groups.time;
                progress['bitrate'] = parseFloat(ffmatch.groups.bitrate);
                progress['dup'] = ffmatch.groups.dup == null ? 0 : parseInt(ffmatch.groups.dup);
                progress['drop'] = ffmatch.groups.drop == null ? 0 : parseInt(ffmatch.groups.drop);
                progress['speed'] = parseFloat(ffmatch.groups.speed);

                let current = 0;
                const times = progress.time.split(':');
                for (let i = 0; i < times.length; i++) {
                    if (i == 0) {
                        current += parseFloat(times[i]) * 3600;
                    } else if (i == 1) {
                        current += parseFloat(times[i]) * 60;
                    } else if (i == 2) {
                        current += parseFloat(times[i]);
                    }
                }

                const percent = current / duration;
                const log =
                    'frame= ' +
                    progress.frame +
                    ' fps=' +
                    progress.fps +
                    ' size=' +
                    progress.size +
                    ' time=' +
                    progress.time +
                    ' bitrate=' +
                    progress.bitrate +
                    ' drop=' +
                    progress.drop +
                    ' speed=' +
                    progress.speed;

                console.log(JSON.stringify({ type: 'progress', percent: percent, log: log }));
            }
        }
    });

    child.on('exit', (code, signal) => {
        if (code === 0) {
            console.log(`?? ffmpeg exited with code: ${code}, signal: ${signal}`);
            return;
        }

        console.error(`?? ffmpeg failed with code: ${code}, trying fallback`);

        const fallbackArgs = args.map(arg => {
            if (arg === '-c:a') return 'aac';
            if (arg === '-bsf:a') return null;
            return arg;
        }).filter(Boolean);

        const fallback = spawn(ffmpeg, fallbackArgs);

        fallback.stderr.on('data', data => {
            console.error('[ffmpeg fallback stderr]', data.toString());
        });

        fallback.on('exit', (code, signal) => {
            console.log(`?? fallback ffmpeg exited with code: ${code}, signal: ${signal}`);
        });
    });

    process.on('SIGINT', () => {
        child.kill('SIGINT');
    });
})();