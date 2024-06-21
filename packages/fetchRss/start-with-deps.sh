#!/bin/bash

# Update package list and install libvips
sudo apt-get update
sudo apt-get install -y libvips

# Ensure optional dependencies can be installed
yarn add sharp --ignore-engines

# Run the Node.js script
node src/index.js