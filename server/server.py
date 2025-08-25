#!/usr/bin/env python3
"""
Flask server to serve static files from the client/ directory.
Uses .env file for configuration.
"""

import os
import logging
import sys
from flask import Flask, send_from_directory
import bambulabs_api as bl
from dotenv import load_dotenv

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/bambu_monitor.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# Load environment variables from .env file
load_dotenv()

app = Flask(__name__)

class BambuPGCode:
    def __init__(self, printer_ip: str, printer_access_code: str, printer_serial: str):
        self.printer = None
        self.running = True
        self.printer_ip = printer_ip
        self.printer_access_code = printer_access_code
        self.printer_serial = printer_serial
        
        # Define routes
        self.define_routes()

    def define_routes(self):
        @app.route('/')
        def serve_index():
            """Serve the main index.html file."""
            return send_from_directory(CLIENT_DIR, 'index.html')

        @app.route('/<path:filename>')
        def serve_static_files(filename: str):
            """Serve static files from the client directory."""
            try:
                return send_from_directory(CLIENT_DIR, filename)
            except FileNotFoundError:
                # Return 404 for missing files
                return "File not found", 404

        @app.errorhandler(404)
        def not_found(error: Exception):
            """Handle 404 errors."""
            return "File not found", 404

    def connect_printer(self):
        """Connect to the BambuLab printer"""
        try:
            logger.info(f"Connecting to printer at {self.printer_ip}...")
            self.printer = bl.Printer(self.printer_ip, self.printer_access_code, self.printer_serial)
            self.printer.connect()
            
            # Start MQTT for real-time data
            logger.info("Starting MQTT connection for real-time data...")
            self.printer.mqtt_start()
            
            # Wait for MQTT to establish connection
            import time
            time.sleep(3)
            
            logger.info("Successfully connected to printer with MQTT")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to printer: {e}")
            return False
            
    def disconnect_printer(self):
        """Disconnect from the printer"""
        if self.printer:
            try:
                # Stop MQTT first
                self.printer.mqtt_stop()
                self.printer.disconnect()
                logger.info("Disconnected from printer")
            except Exception as e:
                logger.error(f"Error disconnecting from printer: {e}")
                
def main():
    # Configuration from environment variables
    global HOST, PORT, DEBUG, CLIENT_DIR
    HOST = os.getenv('FLASK_HOST', 'localhost')
    PORT = int(os.getenv('FLASK_PORT', 3000))
    DEBUG = os.getenv('FLASK_DEBUG', 'True').lower() == 'true'
    CLIENT_DIR = os.path.join(os.path.dirname(__file__), '../client')
    print(CLIENT_DIR)
    PRINTER_IP = os.getenv('PRINTER_IP')
    PRINTER_ACCESS_CODE = os.getenv('PRINTER_ACCESS_CODE')
    PRINTER_SERIAL = os.getenv('PRINTER_SERIAL')
    
    if not PRINTER_IP or not PRINTER_ACCESS_CODE or not PRINTER_SERIAL:
        logger.error("Missing required environment variables")
        return

    logger.info(f"Starting Flask server on http://{HOST}:{PORT}/")
    logger.info(f"Serving static files from: {CLIENT_DIR}")
    logger.info(f"Debug mode: {DEBUG}")
    
    bambuClient = BambuPGCode(PRINTER_IP, PRINTER_ACCESS_CODE, PRINTER_SERIAL)
    if not bambuClient.connect_printer():
        logger.error("Failed to connect to printer, exiting...")
        return
    
    try:
        app.run(
            host=HOST,
            port=PORT,
            debug=DEBUG
        )
    finally:
        logger.info("Shutting down...")
        bambuClient.disconnect_printer()
        logger.info("BambuLab monitor stopped")

if __name__ == "__main__":
    main()
