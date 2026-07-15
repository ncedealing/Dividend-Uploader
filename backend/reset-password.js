'use strict';

const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.env.DATA_DIR || '');
const stateFile = path.join(dataDir, 'state.json');
const username = String(process.env.RESET_USERNAME || '').trim();
const password = Buffer.from(process.env.RESET_PASSWORD_B64 || '', 'base64').toString('utf8');

if (!dataDir || !fs.existsSync(stateFile)) throw new Error('State file not found');
if (!username) throw new Error('Username is required');
if (password.length < 12) throw new Error('Password must contain at least 12 characters');

const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const user = Array.isArray(state.users) ? state.users.find(row => row.username === username) : null;
if (!user) throw new Error(`Administrator not found: ${username}`);

user.password_hash = bcrypt.hashSync(password, 12);
const temporaryFile = `${stateFile}.${process.pid}.tmp`;
fs.writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 });
fs.renameSync(temporaryFile, stateFile);
console.log(`Password reset completed for ${username}`);

