const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs').promises; // Use promises for async file operations
const path = require('path');
const crypto = require('crypto'); // For generating secure tokens

const app = express();
const port = 3000; // You can change this port if needed
const dbPath = path.join(__dirname, 'photos.db');
const photosDir = path.join(__dirname, 'Hanphotos'); // <--- Changed directory name
const footageDir = path.join(__dirname, 'Footage');

// Middleware to parse JSON request bodies
app.use(express.json());

// Authentication credentials (in a real app, these would be stored securely)
const AUTH_CREDENTIALS = {
    username: 'doublelucky',
    password: 'admin'
};

// Store active sessions (in a real app, use a proper session store)
const activeSessions = new Map();

// Middleware to check authentication for protected routes
function requireAuth(req, res, next) {
    const authToken = req.headers.authorization?.split(' ')[1];
    
    if (!authToken || !activeSessions.has(authToken)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Token is valid
    next();
}

// --- Database Setup ---
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        // Create the photos table if it doesn't exist
        db.run(`CREATE TABLE IF NOT EXISTS photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT UNIQUE NOT NULL,
            tags TEXT,
            original_filename TEXT
        )`, (err) => {
            if (err) {
                console.error('Error creating table:', err.message);
            } else {
                // Clear the table first, then sync the new directory
                clearPhotosTable().then(() => {
                    console.log('Photos table cleared.');
                    syncPhotosDirectory(); // Sync with the new directory
                }).catch(clearErr => {
                    console.error('Error clearing photos table:', clearErr);
                    // Decide if you still want to sync even if clearing failed
                    // syncPhotosDirectory();
                });
            }
        });
    }
});

// --- Helper Functions ---

// Function to clear the photos table
function clearPhotosTable() {
    return new Promise((resolve, reject) => {
        db.run('DELETE FROM photos', [], function(err) { // Use function() for this.changes
            if (err) {
                reject(err);
            } else {
                // Optional: Reset the autoincrement counter if desired (for SQLite)
                db.run("DELETE FROM sqlite_sequence WHERE name='photos'", [], (resetErr) => {
                    if (resetErr) {
                        console.warn("Could not reset sequence for photos table:", resetErr.message);
                        // Resolve anyway, as the main delete succeeded
                        resolve(this.changes);
                    } else {
                        resolve(this.changes);
                    }
                });
            }
        });
    });
}


// Function to scan the specified photos directory and add new files to DB
async function syncPhotosDirectory() {
    console.log(`Syncing directory: ${photosDir}`); // Log which directory is being synced
    try {
        let files;
        try {
            files = await fs.readdir(photosDir);
        } catch (readDirErr) {
             if (readDirErr.code === 'ENOENT') {
                console.error(`Error: Directory not found: ${photosDir}. Please ensure it exists.`);
                // Optionally create the directory?
                // await fs.mkdir(photosDir, { recursive: true });
                // console.log(`Created directory: ${photosDir}`);
                // files = []; // Start with an empty list if created
                return; // Stop sync if directory doesn't exist and wasn't created
            }
            throw readDirErr; // Re-throw other errors
        }

        const imageFiles = files.filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file)); // Filter for common image types

        // Get existing filenames from DB
        db.all('SELECT filename FROM photos', [], async (err, rows) => {
            if (err) {
                console.error('Error fetching existing photos from DB:', err.message);
                return;
            }
            const existingFilenames = new Set(rows.map(row => row.filename));

            // Find new files
            const newFiles = imageFiles.filter(file => !existingFilenames.has(file));

            if (newFiles.length > 0) {
                console.log(`Found ${newFiles.length} new photos. Adding to database...`);
                const stmt = db.prepare('INSERT OR IGNORE INTO photos (filename, original_filename, tags) VALUES (?, ?, ?)');
                for (const file of newFiles) {
                    stmt.run(file, file, '[]', (err) => { // Initialize tags as empty JSON array string
                         if (err) {
                            console.error(`Error inserting ${file}:`, err.message);
                        }
                    });
                }
                stmt.finalize((err) => {
                     if (err) {
                        console.error('Error finalizing statement:', err.message);
                    } else {
                        console.log('Database sync complete.');
                    }
                });
            } else {
                console.log('No new photos found in directory. Database is up-to-date.');
            }

            // Optional: Check for files in DB that are no longer in the directory
            const dbFilenames = Array.from(existingFilenames);
            const missingFiles = dbFilenames.filter(dbFile => !imageFiles.includes(dbFile));
            if (missingFiles.length > 0) {
                console.warn(`Warning: ${missingFiles.length} files exist in DB but not in directory:`, missingFiles);
                // Decide how to handle missing files (e.g., delete from DB, mark as missing)
                // For now, just log a warning.
            }
        });

    } catch (err) {
        console.error('Error reading Photos directory:', err);
    }
}


// --- API Endpoints ---

// POST /api/login - Authenticate user
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    // Check credentials
    if (username === AUTH_CREDENTIALS.username && password === AUTH_CREDENTIALS.password) {
        // Generate a random token
        const token = crypto.randomBytes(32).toString('hex');
        
        // Store the token with a timestamp
        activeSessions.set(token, {
            username,
            createdAt: new Date()
        });
        
        // Return the token to the client
        res.json({ token });
    } else {
        // Invalid credentials
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// GET /api/photos - Retrieve all photos from the database
app.get('/api/photos', (req, res) => {
    db.all('SELECT id, filename, tags FROM photos ORDER BY filename', [], (err, rows) => {
        if (err) {
            console.error('Error fetching photos:', err.message);
            res.status(500).json({ error: 'Failed to retrieve photos' });
        } else {
            // Ensure paths use the correct, updated directory name for the web path
            // Note: We still use '/Photos' as the base web path for compatibility, served from photosDir (Hanphotos)
            const photosWithPath = rows.map(photo => ({
                ...photo,
                path: path.join('Photos', photo.filename).replace(/\\/g, '/'), // Construct web path like /Photos/image.jpg
                tags: JSON.parse(photo.tags || '[]') // Parse tags string into array
            }));
            res.json(photosWithPath);
        }
    });
});

// PUT /api/photos/:id - Update photo tags or filename (protected)
app.put('/api/photos/:id', requireAuth, async (req, res) => {
    const photoId = parseInt(req.params.id, 10);
    const { filename: newFilename, tags } = req.body;

    if (isNaN(photoId)) {
        return res.status(400).json({ error: 'Invalid photo ID' });
    }
    if (!newFilename && !tags) {
        return res.status(400).json({ error: 'No update data provided (filename or tags)' });
    }
    if (tags && !Array.isArray(tags)) {
         return res.status(400).json({ error: 'Tags must be an array of strings' });
    }

    try {
        // Get current filename from DB
        const currentPhoto = await new Promise((resolve, reject) => {
            db.get('SELECT filename FROM photos WHERE id = ?', [photoId], (err, row) => {
                if (err) reject(new Error('Database error fetching current filename'));
                else if (!row) reject(new Error('Photo not found'));
                else resolve(row);
            });
        });
        const currentFilename = currentPhoto.filename;
        const currentPath = path.join(photosDir, currentFilename);

        let updateQuery = 'UPDATE photos SET';
        const queryParams = [];
        const updates = [];

        // --- Handle Filename Change ---
        let finalFilename = currentFilename;
        if (newFilename && newFilename !== currentFilename) {
            const newPath = path.join(photosDir, newFilename);

            // Basic validation for filename
            if (newFilename.includes('/') || newFilename.includes('\\') || newFilename.startsWith('.')) {
                 return res.status(400).json({ error: 'Invalid new filename.' });
            }
             // Check if new filename already exists (in filesystem or DB for another ID)
            const fileExists = await fs.access(newPath).then(() => true).catch(() => false);
            const dbConflict = await new Promise((resolve, reject) => {
                db.get('SELECT id FROM photos WHERE filename = ? AND id != ?', [newFilename, photoId], (err, row) => {
                    if (err) reject(new Error('Database error checking filename conflict'));
                    else resolve(!!row); // True if a row exists
                });
            });

            if (fileExists || dbConflict) {
                return res.status(409).json({ error: `Filename "${newFilename}" already exists.` });
            }

            // Rename file on filesystem
            await fs.rename(currentPath, newPath);
            console.log(`Renamed ${currentFilename} to ${newFilename}`);

            updates.push('filename = ?');
            queryParams.push(newFilename);
            finalFilename = newFilename; // Use the new filename for the response
        }

        // --- Handle Tags Update ---
        if (tags) {
            updates.push('tags = ?');
            queryParams.push(JSON.stringify(tags)); // Store tags as JSON string
        }

        // --- Update Database ---
        if (updates.length > 0) {
            updateQuery += ` ${updates.join(', ')} WHERE id = ?`;
            queryParams.push(photoId);

            await new Promise((resolve, reject) => {
                db.run(updateQuery, queryParams, function(err) { // Use function() to access this.changes
                    if (err) {
                        reject(new Error(`Database update error: ${err.message}`));
                    } else if (this.changes === 0) {
                        reject(new Error('Photo not found or no changes made'));
                    } else {
                        resolve();
                    }
                });
            });
        }

        res.json({
            message: 'Photo updated successfully',
            id: photoId,
            filename: finalFilename, // Return the potentially updated filename
            tags: tags || JSON.parse(currentPhoto.tags || '[]') // Return updated or existing tags
        });

    } catch (error) {
        console.error(`Error updating photo ${photoId}:`, error);
        // Attempt to rollback rename if DB update failed after rename
        if (newFilename && newFilename !== currentFilename) {
            try {
                await fs.rename(path.join(photosDir, newFilename), currentPath);
                console.warn(`Rolled back rename for photo ${photoId} due to error.`);
            } catch (rollbackError) {
                console.error(`Failed to rollback rename for photo ${photoId}:`, rollbackError);
            }
        }
        res.status(500).json({ error: `Failed to update photo: ${error.message}` });
    }
});


// --- Static File Serving ---
// Serve files from the photos directory (now Hanphotos) under the same web path '/Photos' for compatibility
// Or change the web path if desired, but update admin.html and index.html accordingly
app.use('/Photos', express.static(photosDir)); // Web path /Photos still serves from the new photosDir (Hanphotos)
// Serve files from the 'Footage' directory
app.use('/Footage', express.static(footageDir));
// Serve other static files (index.html, admin.html, etc.) from the root directory
app.use(express.static(__dirname));

// Serve login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// Serve admin.html specifically (protected)
app.get('/admin', (req, res) => {
    // Redirect to login page - authentication will be handled client-side
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Redirect root to login for admin access
app.get('/', (req, res) => {
    res.redirect('/login');
});

// --- Server Start ---
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Admin login available at http://localhost:${port}/login`);
    console.log(`Admin interface available at http://localhost:${port}/admin`);
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Closed the database connection.');
        process.exit(0);
    });
});
