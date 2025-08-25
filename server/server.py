#!/usr/bin/env python3
"""
Flask server to serve static files from the client/ directory.
Uses .env file for configuration.
"""

import os
from flask import Flask, send_from_directory, send_file
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

app = Flask(__name__)

# Configuration from environment variables
HOST = os.getenv('FLASK_HOST', 'localhost')
PORT = int(os.getenv('FLASK_PORT', 3000))
DEBUG = os.getenv('FLASK_DEBUG', 'True').lower() == 'true'

# Path to client directory
CLIENT_DIR = os.path.join(os.path.dirname(__file__), 'client')

@app.route('/')
def serve_index():
    """Serve the main index.html file."""
    return send_from_directory(CLIENT_DIR, 'index.html')

@app.route('/<path:filename>')
def serve_static_files(filename):
    """Serve static files from the client directory."""
    try:
        return send_from_directory(CLIENT_DIR, filename)
    except FileNotFoundError:
        # Return 404 for missing files
        return "File not found", 404

@app.errorhandler(404)
def not_found(error):
    """Handle 404 errors."""
    return "File not found", 404

if __name__ == '__main__':
    print(f"Starting Flask server on http://{HOST}:{PORT}/")
    print(f"Serving static files from: {CLIENT_DIR}")
    print(f"Debug mode: {DEBUG}")
    
    app.run(
        host=HOST,
        port=PORT,
        debug=DEBUG
    )
