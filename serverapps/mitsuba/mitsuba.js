var fs = require('fs');
var exec = require('child_process').exec;
var spawn = require('child_process').spawn;
var http = require('http');
var https = require('https');
var crypto = require('crypto');
//var download = require('download');

var Mitsuba = {

	last_id: 0,
	clients: [],
	clients_by_id: {},

	temp_folder: "temp",
	valid_extensions: {"jpg":true,"png":true,"obj":true,"serialized":true},

	//hosts the server is allowed to download resources from (besides the host of the editor that connected), comma separated
	download_hosts: ( process.env.MITSUBA_DOWNLOAD_HOSTS || "" ).split(",").map( function(v){ return v.trim().toLowerCase(); } ).filter( Boolean ),

	//only plain file names inside the client folder: no paths, no "..", no hidden files
	isSafeFilename: function( filename )
	{
		return typeof(filename) == "string" && filename.length < 256 && /^[A-Za-z0-9_\-][A-Za-z0-9_.\-]*$/.test( filename ) && filename.indexOf("..") == -1;
	},

	//relative path made only of safe names, e.g. "user/textures/wood.png" (resources keep their folder so the scene XML can find them)
	isSafeRelativePath: function( path )
	{
		if( typeof(path) != "string" || !path.length || path.length > 1024 )
			return false;
		var parts = path.split("/");
		for(var i = 0; i < parts.length; ++i)
			if( !this.isSafeFilename( parts[i] ) )
				return false;
		return true;
	},

	start: function()
	{
		//create temp folder
		if (!fs.existsSync( this.temp_folder )){
			fs.mkdirSync( this.temp_folder );
			if (!fs.existsSync( this.temp_folder )){
				console.log("Error: cannot create temp folder. Check privileges");
			}
		}
	},

	onClientJoin: function( connection, origin )
	{
		var client = new Client( connection, this.last_id, origin );
		this.last_id++;
		this.clients.push( client );
		this.clients_by_id[ client.id ] = client;
		return client;
	},

	onClientLeave: function( client )
	{
		client.onLeave();
		var index = this.clients.indexOf( client );
		if(index == -1)
			return;
		this.clients.splice( index, 1 );
		delete this.clients_by_id[ client.id ];
	},

	onRequest: function ( request, response )
	{
		//do not expose client IPs, only the number of clients
		response.setHeader("Content-Type","application/json");
		response.end( JSON.stringify( { 
			server: "mitsuba",
			num_clients: this.clients.length
		})); //send a response
	}
};

function Client( connection, id, origin )
{
	this.connection = connection;
	this.id = id;
	this.origin = origin || "";
	this.ip = connection.remoteAddress;
	//every client gets its own folder so clients cannot read or overwrite each other's files
	this.folder = Mitsuba.temp_folder + "/" + "user_" + id + "_" + crypto.randomBytes(8).toString("hex");
	this.status = "waiting";
	this.mitsuba_process = null;
	this.all_processes = [];

	this.current_bin = null;
	this._files_pending = 0;

	this.scene = null;

	if (!fs.existsSync( this.folder )){
		fs.mkdirSync( this.folder );
		if (!fs.existsSync( this.folder )){
			console.log("Error: cannot create user folder. Check privileges");
		}
	}

	this.send({ action:"info", folder: this.folder });
}

//for JSON messages
Client.prototype.onMessage = function( msg )
{
	var that = this;
	if(msg.action == "scene")
	{
		this.writeFile( "scene.xml", msg.xml );
		this.scene = msg.xml;
		this.log("scene received" );
	}
	else if(msg.action == "rename")
	{
		if( !Mitsuba.isSafeFilename( msg.filename ) )
			return this.error("invalid filename");
		fs.rename( this.folder + "/file.bin", this.folder + "/" + msg.filename, function(err){
			if(err)
				that.error("rename failed");
		});
		this.log("file renamed to: " + msg.filename );
	}
	else if(msg.action == "renderFrame")
	{
		if(msg.xml)
		{
			this.writeFile( "scene.xml", msg.xml );
			this.scene = msg.xml;
		}
		this.log("starting render..." );
		this.startRender();
	}
	else if(msg.action == "startbin")
	{
		if( !Mitsuba.isSafeFilename( msg.filename ) ) //safety
			return this.error("invalid filename");
		this.log("starting bin file for: " + msg.filename );
		var fullpath = this.folder + '/' + msg.filename;
		if( this.current_bin && this.current_bin.stream )
		{
			this.current_bin.stream.end();
			this._files_pending -= 1;
		}
		this._files_pending += 1;
		this.current_bin = {
			filename: fullpath,
			basename: msg.filename,
			stream: fs.createWriteStream( fullpath )
		};
	}
	else if(msg.action == "endbin")
	{
		if( !this.current_bin || !this.current_bin.stream )
			return;
	
		this.log("ending bin file for: " + this.current_bin.basename );
		var filename = 	this.current_bin.filename;
		var basename = 	this.current_bin.basename;
		this.current_bin.stream.end(null,null, function(){
			if( msg.size )
			{
				var stats = fs.statSync( filename );
				if( stats.size != msg.size )
					that.error("Size missmatch: " + stats.size + " of " + msg.size );
			}
			that._files_pending -= 1;
			if(msg.unzip)
				that.unzipFile( basename );
		});
		this.current_bin = null;
	}
	else if(msg.action == "download")
	{
		if( typeof(msg.url) != "string" || typeof(msg.full_url) != "string" )
			return this.error("invalid download request");
		this.downloadURL( msg.url, msg.full_url );
	}
}

Client.prototype.writeFile = function( filename, data )
{
	if( !Mitsuba.isSafeFilename( filename ) ) //safety
	{
		console.log("dangerous filename:", filename );
		return;
	}
	if( typeof(data) != "string" )
	{
		this.error("invalid file content");
		return;
	}

	var that = this;
	this._files_pending += 1;
	var final_filename = this.folder + "/" + filename;
	var wstream = fs.createWriteStream( final_filename );
	wstream.write( data );
	wstream.end(null,null, function(){
		if (!fs.existsSync( final_filename ))
			console.log("Warning: file not written!",final_filename);
		that._files_pending -= 1;
	});
}

Client.prototype.unzipFile = function( filename, on_complete )
{
	var that = this;
	//-o overwrite. Info-ZIP unzip already strips absolute paths and "../" from entries (zip slip), we do NOT pass "-:" which would allow them
	var process = spawn( 'unzip', [ '-o', filename ], { cwd: this.folder } );
	this.all_processes.push( process );

	process.stdout.on('data', function (data) {
		that.log('stdout: ' + data.toString());
	});

	process.stderr.on('data', function (data) {
	  that.log('stderr: ' + data.toString());
	});

	process.on('exit', function (code) {
	  that.log('zip process exited with code ' + code.toString());
	  var index = that.all_processes.indexOf( process );
	  if( index != -1 )
		that.all_processes.splice(index,1);
	  if(on_complete)
		  on_complete();
	});	
}

Client.prototype.onBinary = function( data )
{
	if( !this.current_bin || !this.current_bin.stream )
		return;
	this.current_bin.stream.write( data );
	//console.log("bin data received:",data.length);
}

Client.prototype.send = function( data )
{
	if( !this.connection || !this.connection.connected )
		return;
	if( data.constructor === Object )
		this.connection.send( JSON.stringify( data ) );
	else if( data.constructor === ArrayBuffer )
	{
		var buffer = Buffer.from( data );
		this.connection.sendBytes( buffer );
	}
}

Client.prototype.log = function(msg)
{
	var args = Array.prototype.slice.call(arguments);
	var d = args.join(",");
	//if( d.indexOf("\r") == -1 ) //avoid filling the console
		console.log( this.ip,":",d );
	this.send({ action:"log", content: d });
}

Client.prototype.error = function(msg)
{
	var args = Array.prototype.slice.call(arguments);
	var d = args.join(",");
	//if( d.indexOf("\r") == -1 ) //avoid filling the console
		console.error( this.ip,":",d );
	this.send({ action:"error", content: d });
}

Client.prototype.getFileExtension = function( filename )
{
	var index = filename.lastIndexOf(".");
	if(index == -1)
		return "";
	return filename.substr(index+1).toLowerCase();
}

Client.prototype.downloadURL = function( filename, url, on_complete )
{
	var that = this;
	var ext = this.getFileExtension( filename );
	if( !Mitsuba.valid_extensions[ ext ] || !Mitsuba.isSafeRelativePath( filename ) )
	{
		this.log("invalid filename");
		return false;
	}

	//avoid SSRF: only http(s) and only from the editor host or the configured hosts
	var url_info = null;
	try
	{
		url_info = new URL( url );
	}
	catch (err)
	{
		this.error("invalid url");
		return false;
	}
	if( url_info.protocol != "http:" && url_info.protocol != "https:" )
	{
		this.error("only http/https downloads are allowed");
		return false;
	}
	var origin_host = "";
	try { origin_host = new URL( this.origin ).host.toLowerCase(); } catch (err) {}
	var host = url_info.host.toLowerCase();
	if( host != origin_host && Mitsuba.download_hosts.indexOf( host ) == -1 )
	{
		this.error("download host not allowed: " + host );
		return false;
	}

	var fullname = this.folder + "/" + filename;

	if ( fs.existsSync( fullname ) )
		return false; //already downloaded

	this.log( "Downloading remote file: " + filename );

	//node stuff
	this._files_pending += 1;
	var done = false;
	function finish( ok )
	{
		if(done)
			return;
		done = true;
		that._files_pending -= 1;
		if(ok)
		{
			that.log( "File downloaded: " + filename );
			if(on_complete)
				on_complete();
		}
	}

	var request = ( url_info.protocol == "https:" ? https : http ).get( url_info, function(response) {
		if(response.statusCode != 200)
		{
			response.resume();
			that.log("File not found: " + filename);
			finish(false);
			return;
		}
		var folder = fullname.substr( 0, fullname.lastIndexOf("/") );
		try
		{
			fs.mkdirSync( folder, { recursive: true } );
		}
		catch (err)
		{
			response.resume();
			that.error("cannot create folder for: " + filename );
			finish(false);
			return;
		}
		var file = fs.createWriteStream( fullname );
		response.pipe(file);
		file.on("finish", function(){ finish(true); });
		file.on("error", function(e){ that.error("cannot write file: " + filename ); finish(false); });
	});

	request.setTimeout( 60000, function(){ request.destroy( new Error("timeout") ); });

	request.on('error', (e) => {
		that.error('problem with request: ' + e.message );
		finish(false);
	});

	return true;
}

Client.prototype.startRender = function()
{
	var that = this;

	//call mitsuba
	if( this._files_pending > 0 )
	{
		this.log("Files pending... waiting");
		setTimeout( this.startRender.bind(this), 2000 );
		return;
	}
	this.log("Files ready.");
	this.log("Launching render process...");
	this.launchMitsuba( inner_complete, inner_on_error );

	function inner_complete()
	{
		that.send({ action: "frame_ready", url: that.folder + "/scene.png" });
	}

	function inner_on_error(code)
	{
		that.send({ action: "error_mitsuba", code: code });
	}
}

Client.prototype.launchMitsuba = function( on_complete, on_error )
{
	//kill if still running
	if( this.mitsuba_process )
		this.mitsuba_process.kill();

	//launch mitsuba process
	var that = this;
	var process = this.mitsuba_process = spawn( 'mitsuba', [ 'scene.xml', '-o', 'scene.exr'], { cwd: this.folder } );
	this.all_processes.push( process );

	//get output
	process.stdout.on('data', function (data) {
		that.log('stdout: ' + data.toString() );
	});

	process.stderr.on('data', function (data) {
		that.log('stderr: ' + data.toString());
	});

	process.on('exit', function (code) {
		that.log('mitsuba process exited with code ' + code.toString());
		that.mitsuba_process = null;
		var index = that.all_processes.indexOf( process );
		if( index != -1 )
			that.all_processes.splice( index, 1 );
		if( code != 0 ) //error
		{
			if(on_error)
				on_error(code)
			return;
		}
		that.applyToneMapping( on_complete );
	});	
}

Client.prototype.applyToneMapping = function( on_complete )
{
	//launch mitsuba process
	var that = this;
	var process = spawn( 'mtsutil', [ 'tonemap', 'scene.exr' ], { cwd: this.folder } );
	this.all_processes.push( process );

	//get output
	process.stdout.on('data', function (data) {
		that.log('stdout: ' + data.toString());
	});

	process.stderr.on('data', function (data) {
		that.log('stderr: ' + data.toString());
	});

	process.on('exit', function (code) {
		that.log('tonemapping process exited with code ' + code.toString());
		var index = that.all_processes.indexOf( process );
		if( index != -1 )
			that.all_processes.splice(index,1);
		if(on_complete)
			on_complete();
	});	
}


Client.prototype.onLeave = function()
{
	var that = this;
	console.log( "user leaving: " + this.ip );

	if( this.current_bin && this.current_bin.stream )
		this.current_bin.stream.end();
	this.current_bin = null;

	//do not leave anything running
	if(this.all_processes.length)
	{
		console.log("Killing all processes attached to client " + this.id );
		for(var i = 0; i < this.all_processes.length; ++i)
		{
			var process = this.all_processes[i];
			process.kill();
		}
		this.all_processes.length = 0;
	}

	//clear folder on disconnection (each client has its own folder)
	if (fs.existsSync( this.folder )){
		console.log("Deleting user temp folder: " + this.folder );
		try
		{
			deleteFolderRecursive( that.folder );
		}
		catch (err)
		{
			console.error("Error deleting folder:", err );
		}
	}
}

Client.prototype.toJSON = function()
{
	return {
		id: this.id,
		ip: this.ip,
		status: this.status
	};
}

module.exports = Mitsuba;


var deleteFolderRecursive = function(path) {
  if (fs.existsSync(path)) {
    fs.readdirSync(path).forEach(function(file, index){
      var curPath = path + "/" + file;
      if (fs.lstatSync(curPath).isDirectory()) { // recurse
        deleteFolderRecursive(curPath);
      } else { // delete file
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(path);
  }
};