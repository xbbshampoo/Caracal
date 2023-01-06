var express = require('express'),
    compression = require('compression'),
    morgan = require('morgan'),
    formidable = require('formidable'),
    mime = require('mime'),
    fs = require('fs'),
    path = require('path'),
    url = require('url'),
    http = require('follow-redirects').http,
    https = require('follow-redirects').https,
    crypto = require('crypto'),
    temp = require('temp'),
    gm = require('gm'),
    async = require('async'),
    Nedb = require('nedb'),
    ffmpeg = require('fluent-ffmpeg'),
    cors = require('cors');

var config = {
    // Listening HTTP Port
    port: process.env.HTTP_PORT || 8075,

    // HTTP Cache value for the stored files
    cache: process.env.CACHE || "max-age=290304000, public",

    // The user agent used by the HTTP client to fetch distant files
    "User-Agent": process.env.UA || "Mozilla/5.0 (Windows NT 6.1; WOW64; rv:28.0) Gecko/20100101 Firefox/28.0",

    // A password required to delete files.
    // /!\ Please change it. /!\
    "deletions-key": process.env.DELETIONS_KEY || "caracal18",

    // An authentication association table (object) used for basic HTTP authentifications
    // keys are the host-names, values are the passwords
    auths: process.env.AUTHS ? JSON.parse(process.env.AUTHS) : {},

    // Number of allowed concurrent GraphicsMagick processes
    concurrency: process.env.CONCURRENCY ? parseInt(process.env.CONCURRENCY) : 8,

    // Number of allowed concurrent FFmpeg processes
    // Is CONCURRENCY divided by 4 by default
    videoConcurrency: process.env.VIDEO_CONCURRENCY ? parseInt(process.env.VIDEO_CONCURRENCY) : (
        process.env.CONCURRENCY ? Math.min(Math.round(parseInt(process.env.CONCURRENCY) / 4)) : 2
    ),

    // Location of the storage folder, server side
    datapath: process.env.DATAPATH || './data',

    // Array of allowed resizing sizes
    // So the user cannot ask every resized image pixel by pixel
    // If a requested size is not found, the closest size from this array is used.
    // Define it to '*' to allow every size (not recommended)
    // The default configuration contains many sizes, you might want to use fewer sizes
    allowedSizes: process.env.ALLOWED_SIZES ? JSON.parse(process.env.ALLOWED_SIZES) :
        [32, 64, 128, 256, 1024, 2048, 4096, 8192, 16384,
            50, 100, 200, 400, 500, 600, 800, 1000, 1050, 1200, 1600,
            120, 160, 240, 320, 480, 576, 640, 768, 854, 960, 1050, 1080,
            1152, 1280, 1440, 1536, 1716, 1920, 2160, 2560, 3200,
            3840, 3996, 4320, 4800, 5120, 6400, 6144, 7680, 12288,
        ],

    // Array of allowed resizing video size. This MUST be an array
    allowedVideoSizes: process.env.ALLOWED_VIDEO_SIZES ? JSON.parse(process.env.ALLOWED_VIDEO_SIZES) :
        [144, 240, 360, 480, 720, 1080, 3840],

    // List of allowed domains for CORS
    allowedDomains: process.env.ALLOWED_DOMAINS ? JSON.parse(process.env.ALLOWED_DOMAINS) : '*',

    // Dependencie used to generate ids
    idsGeneration: process.env.IDS_GENERATION ? process.env.IDS_GENERATION : 'sillyid',
};

// Generation of ids
// The ids must never start by http: or https:
// They should never have path characters
// Accepted characters
//    a-z A-Z 0-9 _-
// No accepted (and many others)
//    : / \ . < > ( ) [ ]
// GenerateId has the sha256 checksum as optional argument
var generateId = (hash) => hash;
switch (config.idsGeneration) {
    case 'hash':
        // Just return the hash
        break;
    case 'shortid':
        var shortid = require('shortid');
        generateId = () => shortid.generate();
        break;
    case 'human-readable':
        var humanreadableid = require('human-readable-ids').hri;
        generateId = () => humanreadableid.random();
        break;
    case 'bronze':
        var bronze = require('bronze');
        var bronzeInstance = new bronze();
        generateId = () => bronzeInstance.generate();
        break;
    case 'sillyid':
    default:
        var sillyid = require('sillyid');
        var sillyidInstance = new sillyid();
        generateId = () => sillyidInstance.generate();
}

var datapath = config.datapath;
if (datapath.slice(-1) !== '/') {
    datapath += '/';
}
var uploadDatapath = datapath + "uploads";

// Create the uploads folder if necessary
if (!fs.existsSync(uploadDatapath)) {
    fs.mkdirSync(uploadDatapath);
}

// Open the databases
var filesDb = new Nedb({filename: datapath + 'files.db', autoload: true}),
    picturesSizeDb = new Nedb({filename: datapath + 'picturesSizes.db', autoload: true}),
    idsDb = new Nedb({filename: datapath + 'ids.db', autoload: true});

// Create the indexes, sparse allows multiple documents with an undefined field
filesDb.ensureIndex({fieldName: 'url', unique: true, sparse: true});
filesDb.ensureIndex({fieldName: 'mtime', unique: false, sparse: true});
idsDb.ensureIndex({fieldName: 'id', unique: true, sparse: true});
idsDb.ensureIndex({fieldName: 'hash', unique: true, sparse: true});


var gmWorker = async.queue((task, callback) => {
    task(callback);
}, config.concurrency);

var ffmpegWorker = async.queue((task, callback) => {
    task(callback);
}, config.videoConcurrency);

var app = express();

app.use(compression());
app.use(morgan('short'));

if (Array.isArray(config.allowedDomains)) {
    app.use(cors({
        origin: function (origin, callback) {
            var originIsWhitelisted = config.allowedDomains.indexOf(origin) !== -1;
            callback(null, originIsWhitelisted);
        }
    }));
} else {
    app.use(cors());
}

app.use(express.static(__dirname + '/public'));
app.use(express.static(path.resolve(uploadDatapath)));

app.get('/files', (req, res) => {
    filesDb.find({}).sort({mtime: -1}).exec((err, docs) => {
        for (var i = 0, l = docs.length; i < l; ++i) {
            delete docs[i]._id;
        }
        res.send(docs);
    });
});

app.get(/^\/([a-zA-Z0-9_\-]+)$/, (req, res) => {
    var id = req.params[0];
    convertIdToHashAndPath(id, (infos) => {
        res.sendFile(infos.fullPath, {root: __dirname});
    }, () => {
        res.status(404).send("File not found.");
    });
});

app.get('/paginateFiles/:page', (req, res) => {
    var pageSize = req.query.hasOwnProperty('pageSize') ?
            Math.max(2, (parseInt(req.query.pageSize) || 0)) : 10,
        page = Math.max(-1, (parseInt(req.params.page) || 0));


    var req = filesDb.find({});

    if (page >= 0) {
        req.sort({mtime: 1});
        req.skip(pageSize * page);
        req.limit(pageSize);
    } else {
        req.sort({mtime: -1});
        req.limit(pageSize);
    }

    req.exec((err, docs) => {
        for (var i = 0, l = docs.length; i < l; ++i) {
            delete docs[i]._id;
        }
        var req = filesDb.count({}, (err, count) => {
            res.json({
                files: docs,
                count: count
            });
        });
    });

});

app.get(/^\/resize\/(deform\/)?(\d+)\/(\d+)\/([a-fA-F0-9]{40,64}\.[a-zA-Z0-9]+)$/, (req, res) => {
    var path = req.params[3],
        width = parseInt(req.params[1]),
        height = parseInt(req.params[2]),
        deform = !!req.params[0];

    sendResizedImage(path, width, height, deform, res);
});

app.get(/^\/resize\/(deform\/)?(\d+)\/(\d+)\/([a-zA-Z0-9_\-]+)$/, (req, res) => {
    var id = req.params[3],
        width = parseInt(req.params[1]),
        height = parseInt(req.params[2]),
        deform = !!req.params[0];

    convertIdToHashAndPath(id, (infos) => {
        sendResizedImage(infos.path, width, height, deform, res);
    }, () => {
        res.status(404).send("File not found.");
    });
});

app.get(/^\/thumbnail\/([a-fA-F0-9]{40,64}\.[a-zA-Z0-9]+)$/, (req, res) => {
    var path = req.params[0];
    sendThumbnail(path, res);
});

app.get(/^\/thumbnail\/([a-zA-Z0-9_\-]+)$/, (req, res) => {
    var id = req.params[0];
    convertIdToHashAndPath(id, (infos) => {
        sendThumbnail(infos.path, res);
    }, () => {
        res.status(404).send("File not found.");
    });
});

app.post('/upload', (req, res) => {
    var form = new formidable.IncomingForm();
    form.uploadDir = uploadDatapath;
    form.keepExtensions = true;
    form.hash = 'sha256';

    form.parse(req, (err, fields, files) => {
        if (err || !files) {
            console.log("File upload error", err);
            res.status(500).send("Sorry, file upload error");
            return;
        }

        for (var key in files) {
            var f = files[key];

            var extension = mime.extension(f.name ? mime.lookup(f.name) : f.type);


            var path = uploadDatapath + "/" + f.hash + "." + extension;

            fs.exists(path, (exists) => {
                if (exists) {
                    fs.unlink(f.path, () => {
                    });
                    filesDb.findOne({hash: f.hash, extension}, (err, doc) => {
                        if (doc) {
                            doc.status = 'exists';
                            delete doc._id;
                            res.send(doc);
                        } else {
                            res.status(500).send("File's database record doesn't exist.");
                        }
                    });
                } else {

                    fs.rename(f.path, path, () => {
                        convertHashToId(f.hash, extension, (beautifulId) => {
                            var documentInfos = {
                                name: f.name,
                                id: beautifulId,
                                size: f.size,
                                hash: f.hash,
                                extension: extension,
                                type: f.type,
                                mtime: f.lastModifiedDate,
                            };

                            filesDb.insert(documentInfos, () => {
                                documentInfos.status = 'ok';
                                res.send(documentInfos);
                            });
                        });
                    });
                }
            });
            return;
        }
        ;
    })
});

app.get(/^\/remove\/([a-fA-F0-9]{40,64}\.[a-zA-Z0-9]+)$/, (req, res) => {
    var path = req.params[0];
    removeFile(path, req, res);
});

app.get(/^\/remove\/([a-zA-Z0-9_\-]+)$/, (req, res) => {
    var id = req.params[0];

    convertIdToHashAndPath(id, (infos) => {
        removeFile(infos.path, req, res);
    }, () => {
        res.status(404).send("File not found.");
    });
});

function removeFile(path, req, res) {

    var deletionsKey = config['deletions-key'];
    if (deletionsKey && deletionsKey !== req.query.key) {
        res.status(403).send('Missing or wrong deletions key');
        return;
    }

    var uploadPath = uploadDatapath + "/" + path;

    fs.unlink(uploadPath, () => {
    });

    var hashAndExtension = path.split('.');
    var hash = hashAndExtension[0],
        extension = hashAndExtension[1];

    picturesSizeDb.find({path: path}, (err, docs) => {
        if (err) {
            res.status(500).send(err);
            return;
        }

        docs.forEach((doc) => {
            fs.unlink(doc.unlink, () => {
            });
        });

        picturesSizeDb.remove({path: path});

        idsDb.remove({hash});

        filesDb.remove({hash: hash, extension: extension}, {}, (err, numRemoved) => {
            if (err) {
                res.status(500).send(err);
                return;
            }

            res.send({numRemoved: numRemoved});
        });
    });
};

app.get(/^\/details\/([a-fA-F0-9]{40,64}\.[a-zA-Z0-9]+)$/, (req, res) => {
    var path = req.params[0];
    var hashAndExtension = path.split('.');
    var hash = hashAndExtension[0],
        extension = hashAndExtension[1];

    fileDetails(hash, extension, res);
});

app.get(/^\/details\/([a-zA-Z0-9_\-]+)$/, (req, res) => {
    var id = req.params[0];

    convertIdToHashAndPath(id, (infos) => {
        fileDetails(infos.hash, infos.extension, res);
    }, () => {
        res.status(404).send("File not found.");
    });
});

function fileDetails(hash, extension, res) {
    filesDb.findOne({hash, extension}, (err, doc) => {
        if (doc) {
            delete doc._id;
            res.send(doc);
        } else {
            res.status(404).send("File not found, sorry");
        }
    });
};

function createThumbnail(path, uploadPath, thumbnailPath, res) {
    gmWorker.push((callback) => {
        gm(uploadPath).autoOrient().thumb(128, 128, thumbnailPath, 90, callback);
    }, (err) => {
        if (err) {
            res.redirect('/broken_thumbnail.png');
            console.log(err);
            return;
        }
        picturesSizeDb.insert({unlink: thumbnailPath, path: path});
        res.header('Cache-Control', config.cache);
        res.sendFile(thumbnailPath, {root: __dirname});
    });
}

function sendThumbnail(path, res) {
    var thumbnailPath = uploadDatapath + "/thumbnail-" + path,
        uploadPath = uploadDatapath + "/" + path;

    var isVideo = /^video\//.test(mime.lookup(path));

    if (isVideo) {
        thumbnailPath += '.png';
    }

    fs.exists(thumbnailPath, (exists) => {
        if (exists) {
            res.header('Cache-Control', config.cache);
            res.sendFile(thumbnailPath, {root: __dirname});
        } else {
            fs.exists(uploadPath, (exists) => {
                if (!exists) {
                    res.status(404).send("File not found, sorry");
                    return;
                }

                if (isVideo) {
                    ffmpegWorker.push((callback) => {
                        ffmpeg(uploadPath).on('error', (err, stdout, stderr) => {
                            console.log(err);
                            res.redirect('/broken_thumbnail.png');
                            callback();
                        }).on('end', () => {
                            var ffmpegPath = uploadDatapath + '/ffmpeg-1-' + path + '.png'
                            picturesSizeDb.insert({unlink: ffmpegPath, path: path});
                            callback();
                            createThumbnail(path, ffmpegPath, thumbnailPath + '.png', res);
                        }).takeScreenshots({
                            count: 1,
                            timemarks: ['0.1'],
                            filename: 'ffmpeg-%i-%f'
                        }, uploadDatapath);
                    });

                    // If it's not a video, imagemagick will do the job
                    // We don't check the filetype, the error callback is triggered if
                    // imagemagick can't create a thumbnail
                } else {
                    createThumbnail(path, uploadPath, thumbnailPath, res);
                }

            });
        }
    });
}

function closestInArray(array, goal) {
    return array.reduce((prev, curr) =>
        Math.abs(curr - goal) < Math.abs(prev - goal) ? curr : prev);
}

function sendResizedImage(path, width, height, deform, res) {
    // If only a set of sizes is allowed, use the closest sizes
    if (Array.isArray(config.allowedSizes)) {
        width = closestInArray(config.allowedSizes, width);
        height = closestInArray(config.allowedSizes, height);
    }

    var resizedPath = "/" + width + "x" + height + (deform ? "-deform-" : "-") + path,
        fullResizedPath = uploadDatapath + resizedPath,
        uploadPath = uploadDatapath + "/" + path;

    fs.exists(fullResizedPath, (exists) => {
        if (exists) {
            res.header('Cache-Control', config.cache);
            res.sendFile(fullResizedPath, {root: __dirname});
        } else {
            fs.exists(uploadPath, (exists) => {
                if (!exists) {
                    res.status(404).send("File not found, sorry");
                    return;
                }

                gmWorker.push((callback) => {
                    gm(uploadPath).autoOrient().resize(width, height, deform ? '!>' : '>')
                        .noProfile().write(fullResizedPath, callback);
                }, (err) => {
                    if (err) {
                        console.log(err);
                        res.redirect('/broken_thumbnail.png');
                        return;
                    }

                    picturesSizeDb.insert({unlink: fullResizedPath, path: path});

                    res.header('Cache-Control', config.cache);
                    res.sendFile(fullResizedPath, {root: __dirname});
                });
            });

        }
    });
}

function sendConvertedVideo(path, format, size, res) {
    size = closestInArray(config.allowedVideoSizes, size);

    var convertedPath = "/ffmpeg-" + path + "-" + size + "." + format,
        fullConvertedPath = uploadDatapath + "/" + convertedPath,
        uploadPath = uploadDatapath + "/" + path;

    fs.exists(fullConvertedPath, (exists) => {
        if (exists) {
            res.header('Cache-Control', config.cache);
            res.sendFile(fullConvertedPath, {root: __dirname});
        } else {
            fs.exists(uploadPath, (exists) => {
                if (!exists) {
                    res.status(404).send("File not found, sorry");
                    return;
                }

                console.log("The file " + path + " will be converted to " + format);

                ffmpegWorker.push((callback) => {
                    var proc = new ffmpeg(uploadPath);

                    if (format === 'mp4') {
                        proc.format('mp4')
                            .videoCodec('libx264')
                            .audioCodec('aac');
                    } else if (format === 'webm') {
                        proc.format('webm')
                            .videoCodec('libvpx')
                            .audioCodec('libvorbis');
                    } else if (format === 'webp') {
                        proc.format('webp')
                            .videoCodec('libwebp_anim')
                            .addOption('-preset', 'default')
                            .addOption('-loop', '0')
                            .addOption('-an')
                            .addOption('-vsync', '0')
                            .addOption('-qscale', '100');
                    }


                    proc.size('?x' + size)
                        /*.fps(30)
                        .audioChannels(2)
                        .audioFrequency(44100)
                        .audioBitrate('192k')*/
                        .on('end', () => {
                            console.log("The file " + path + " has been converted succesfully.");
                            picturesSizeDb.insert({unlink: fullConvertedPath, path: path});
                            res.header('Cache-Control', config.cache);
                            res.sendFile(fullConvertedPath, {root: __dirname});
                            callback();
                        })
                        .on('error', (err) => {
                            console.log('An error happened: ' + err.message);
                            res.status(500).send(err.message);
                            fs.exists(fullConvertedPath, (exists) => {
                                if (exists) {
                                    fs.unlink(fullConvertedPath, () => {
                                    });
                                }
                            });
                            callback();
                        })
                        .output(fullConvertedPath)
                        //.output(res, {end: true}) // the streaming doesn't work with mp4
                        // (it does with flv and .preset('flashvideo') )
                        .run();
                });
            })
        }
    })
}

function fetchDistantFile(u2, res, callback, reserror) {
    // Outlook doesn't like the http://
    // It's maybe the same for some other softwares
    u2 = u2.replace(/^http(s?):\/([^\/])/, 'http$1://$2');

    filesDb.find({url: u2}, (err, docs) => {
        if (docs.length) {
            var file = docs[0];

            var path = uploadDatapath + '/' + file.hash + '.' + file.extension;

            if (res) {
                res.sendFile(path, {root: __dirname});
            }

            if (callback) {
                delete file._id;
                callback(path, file.hash, file.extension, file);
            }
        } else {

            var u = url.parse(u2);

            if (!u.auth && config.auths[u.hostname]) {
                u.auth = config.auths[u.hostname];
            }

            u.headers = {
                'User-Agent': config['User-Agent'],
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'fr,en-US;q=0.8,en;q=0.6'
            };

            (u.protocol === 'https:' ? https : http).get(u, (httpres) => {

                var type = httpres.headers['content-type'];

                if (res) {
                    res.status(httpres.statusCode);
                    res.type(type);
                    res.header('Cache-Control', config.cache);
                    httpres.pipe(res);
                }


                var extension = mime.extension(type);

                var temppath = temp.path({suffix: '.' + extension, prefix: 'temp-', dir: uploadDatapath});

                var file = fs.createWriteStream(temppath);

                var hash = crypto.createHash('sha256');
                var size = 0;
                httpres.on('data', (data) => {
                    hash.update(data);
                    size += data.length;
                });

                httpres.pipe(file);
                httpres.on('end', () => {

                    hash = hash.digest('hex');
                    var path = uploadDatapath + '/' + hash + '.' + extension;

                    fs.exists(path, (exists) => {
                        if (exists) {
                            // Just remove the temporary file, we don't need it
                            fs.unlink(temppath, () => {
                            });
                        } else {
                            fs.rename(temppath, path, () => {
                            });
                        }
                    });

                    var name = u2.match(/[^\/]*$/)[0];
                    if (!name) {
                        name = "untitled";
                    }

                    convertHashToId(hash, extension, (beautifulId) => {
                        var fileDetails = {
                            url: u2,
                            name: name,
                            id: beautifulId,
                            size: size,
                            hash: hash,
                            extension: extension,
                            type: type,
                            mtime: new Date(),
                        };

                        filesDb.insert(fileDetails, () => {
                            if (callback) {
                                callback(path, hash, extension, fileDetails);
                            }
                        });
                    });
                });
            }).on('error', (e) => {
                if (res) {
                    res.status(404).send(e.message);
                } else if (reserror) {
                    reserror.status(404).send(e.message);
                }
            });
        }
    });
}

// Generate an unique ID, checking existing ids in the database
// Having a collision (a new id that is already used)
// should be very unlikely.
function generateUniqueId(hash, callback, nbIters) {
    // We give up after a number of iterations
    if (!nbIters || nbIters <= 0) {
        callback(hash);
        return;
    }

    // Generate an id using the selected algorithm
    var id = generateId(hash);

    // Look for collisions
    idsDb.findOne({id}, (err, doc) => {
        // If we find a collision
        if (doc) {
            console.log("/!\\ ID generation collision detected.");
            generateUniqueId(hash, callback, nbIters - 1);
        } else {
            callback(id);
        }
    });
}

// Takes a hash as input and returns an id.
// This modifies the database
function convertHashToId(hash, extension, callback) {
    idsDb.findOne({hash}, (err, doc) => {
        if (doc) {
            callback(doc.id);
        } else {
            generateUniqueId(hash, (id) => {
                idsDb.insert({hash, id, extension});
                callback(id);
            }, 5);
        }
    });
}

// Takes an id as input, and returns a hash, the extension, and the associated path
function convertIdToHashAndPath(id, callbackSuccess, callbackError) {
    idsDb.findOne({id}, (err, doc) => {
        if (doc) {
            doc.path = doc.hash + "." + doc.extension;
            doc.fullPath = uploadDatapath + "/" + doc.path;
            callbackSuccess(doc);
        } else {
            callbackError(err);
        }
    });
}

app.get(/^\/https?:\/\/?.+$/, (req, res) => {
    fetchDistantFile(req.url.slice(1), res);
});

app.get(/^\/fetch\/https?:\/\/?.+$/, (req, res) => {
    fetchDistantFile(req.url.slice(7), false, (filepath, hash, extension, fileDetails) => {
        fileDetails.status = "ok";
        res.send(fileDetails);
    }, res);
});

app.get(/^\/thumbnail\/https?:\/\/?.+$/, (req, res) => {
    var path = req.url.slice(11);

    fetchDistantFile(path, false, (filepath, hash, extension) => {
        sendThumbnail(hash + "." + extension, res);
    }, res);
});

app.get(/^\/resize\/(deform\/)?(\d+)\/(\d+)\/https?:\/\/?.+$/, (req, res) => {
    var path = req.url.match(/^\/resize\/(deform\/)?\d+\/\d+\/(https?:\/\/?.+)$/)[2],
        width = parseInt(req.params[1]),
        height = parseInt(req.params[2]),
        deform = !!req.params[0];

    fetchDistantFile(path, false, (filepath, hash, extension) => {
        sendResizedImage(hash + "." + extension, width, height, deform, res);
    }, res);
});

app.get(/^\/convert\/(mp4|webm|webp)\/(\d+)\/([a-fA-F0-9]{40,64}\.[a-zA-Z0-9]+)$/, (req, res) => {
    var path = req.params[2],
        format = req.params[0];
    size = parseInt(req.params[1]);

    sendConvertedVideo(path, format, size, res);
});

app.get(/^\/convert\/(mp4|webm|webp)\/(\d+)\/([a-zA-Z0-9_\-]+)$/, (req, res) => {
    var id = req.params[2],
        format = req.params[0],
        size = parseInt(req.params[1]);

    convertIdToHashAndPath(id, (infos) => {
        sendConvertedVideo(infos.path, format, size, res);
    }, () => {
        res.status(404).send("File not found.");
    });
});

app.get(/^\/convert\/(mp4|webm|webp)\/(\d+)\/(https?:\/\/?.+)$/, (req, res) => {
    var path = req.params[2],
        format = req.params[0],
        size = parseInt(req.params[1]);

    fetchDistantFile(path, false, (filepath, hash, extension) => {
        sendConvertedVideo(hash + "." + extension, format, size, res);
    }, res);
});

var server = app.listen(config.port, () => {
    console.log("Server started on http://localhost:" + config.port + "/");
});
