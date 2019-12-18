const fs = require('fs');

module.exports.saveFileSync = (file, fileName) => {
    return new Promise((resolve, reject) => {
        file.mv(fileName, (error) => {
            if (error) {
                reject(error);
            }
            resolve(fileName);
        });
    });
}