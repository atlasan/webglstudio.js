<?php
/* 
	Deployer.php by Javi Agenjo (2017) is a script that enabled to deploy a series of remote files to a folder in this machine.
	Created for WebGLStudio, it can be used in any project. It requires a json with a list of files to download.
 */

	if(file_exists('config.php'))
		require('config.php');
	else
		die('{"status":-1,"msg":"config.php not found. remember to copy config.sample.php to config.php as you edit the content."}');
	
	//*************************************


	$from_console = php_sapi_name() == 'cli';

	//extensions that can never be deployed, whatever config.php says (server-side code and server config files)
	$ALWAYS_FORBIDDEN_EXTENSIONS = array( "php","php3","php4","php5","php7","php8","phtml","pht","phps","phar","inc",
		"asp","aspx","jsp","cgi","pl","py","sh","exe","vbs","shtml","htaccess","htpasswd" );

	$ignore_extensions = array_map( "trim", explode( ",", strtolower( isset($IGNORE_EXTENSIONS) ? $IGNORE_EXTENSIONS : "" ) ) );
	$ignore_extensions = array_values( array_filter( array_unique( array_merge( $ignore_extensions, $ALWAYS_FORBIDDEN_EXTENSIONS ) ) ) );

	//returns true if the relative path is safe to use inside the deploy folder
	function isSafeRelativePath( $path, $allow_empty = false )
	{
		if( !is_string($path) )
			return false;
		if( $path === "" )
			return $allow_empty;
		if( strpos( $path, "\0" ) !== false || strpos( $path, "\\" ) !== false )
			return false;
		if( $path[0] == "/" || preg_match( '/^[a-zA-Z]+:/', $path ) ) //absolute path or scheme
			return false;
		foreach( explode( "/", $path ) as $part )
		{
			if( $part === "" || $part === "." || $part === ".." )
				return false;
			if( $part[0] == "." ) //no dot files (.htaccess, .user.ini, .git...)
				return false;
		}
		return true;
	}

	//returns true if any of the dot-separated parts of the filename is a forbidden extension (catches "shell.php.png" too)
	function hasForbiddenExtension( $filename )
	{
		global $ignore_extensions;
		$parts = explode( ".", strtolower( basename( $filename ) ) );
		array_shift( $parts ); //remove the name itself
		foreach( $parts as $ext )
			if( in_array( $ext, $ignore_extensions, true ) )
				return true;
		return false;
	}

	function downloadFile( $url, $output_filename )
	{
		set_time_limit(0);

		$url_info = parse_url($url);
		if( !$url_info || !isset($url_info["scheme"]) || !in_array( strtolower($url_info["scheme"]), array("http","https"), true ) )
		{
			echo "[Only http/https URLs are allowed]";
			return false;
		}

		$url_path = isset($url_info["path"]) ? $url_info["path"] : "";
		if( hasForbiddenExtension( $url_path ) || hasForbiddenExtension( $output_filename ) )
		{
			echo "[File type forbidden:" . basename( $output_filename ) . "]";
			return false;
		}

		$now = microtime(true);

		$file = fopen( $output_filename, 'w+');
		if(!$file)
		{
			echo "[cannot create file]";
			return false;
		}
		$curl = curl_init($url);

		// Update as of PHP 5.4 array() can be written []
		curl_setopt_array( $curl, [
			CURLOPT_URL            => $url,
			CURLOPT_FOLLOWLOCATION => true,
			CURLOPT_MAXREDIRS      => 5,
			CURLOPT_PROTOCOLS      => CURLPROTO_HTTP | CURLPROTO_HTTPS, //never file://, gopher://...
			CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
			//CURLOPT_RETURNTRANSFER => 1,
			CURLOPT_FILE           => $file,
			CURLOPT_TIMEOUT        => 50,
			CURLOPT_USERAGENT      => 'Mozilla/4.0 (compatible; MSIE 5.01; Windows NT 5.0)'
		]);

		$result = curl_exec($curl);

		if($result === false) {
			echo 'Curl error: ' . curl_error($curl);
			curl_close($curl);
			return false;
		}

		//check if there was an error
		$code = curl_getinfo( $curl, CURLINFO_HTTP_CODE );
		curl_close($curl);
		if($code !== 200)
		{
			echo "[STATUS:". strval($code). "]";
			//echo print_r(curl_getinfo( $curl ),true);
			return false;
		}

		$elapsed = microtime(true) - $now;
		echo " " . number_format( ($elapsed * 1000), 2, '.', '') ."ms ";

		return true;
	}

	//read data
	if(!$from_console)
	{
		//allow to deploy from any remote server
		header("Access-Control-Allow-Origin: *");
		header('Content-Type: application/json');

		if( isset($_REQUEST["action"]) )
		{
			$action = $_REQUEST["action"];
			if($action == "test")
				die('{"status":1,"msg":"ready"}');
			else if($action == "report")
			{
				if( !isset($_REQUEST["token"]) )
					die('{"status":-1,"msg":"params missing"}');
				$token = $_REQUEST["token"];
				if( !is_string( $token ) || !ctype_alnum( $token ) )
					die('{"status":-1,"msg":"incorrect token"}');
				if( !file_exists( "deploy_" . $token . ".log") )
					die('{"status":-1,"msg":"deploy not found"}');
				$content = file_get_contents( "deploy_" . $token . ".log" );
				die( json_encode( array( "status" => 1, "msg" => "report", "log" => $content ), JSON_INVALID_UTF8_SUBSTITUTE ) );
			}
			else if($action == "end")
			{
				if( !isset($_REQUEST["token"]) )
					die('{"status":-1,"msg":"params missing"}');
				$token = $_REQUEST["token"];
				if( !is_string( $token ) || !ctype_alnum( $token ) )
					die('{"status":-1,"msg":"incorrect token"}');

				if( !file_exists( "deploy_" . $token . ".log") )
					die('{"status":-1,"msg":"deploy not found"}');
				unlink( "deploy_" . $token . ".log" ); //delete
				die('{"status":1,"msg":"end"}');
			}
			else
				die('{"status":0,"msg":"unknown action"}');
		}

		if( empty($KEY) )
			die('{"status":-1,"msg":"local key not set, remember to change the local key in the top of the deployer.php file"}');

		if( empty($BASE_DEPLOY_FOLDER) || !is_string($BASE_DEPLOY_FOLDER) ) //an empty folder would deploy to the filesystem root ("/")
			die('{"status":-1,"msg":"BASE_DEPLOY_FOLDER not set in config.php"}');

		if( !isset($_REQUEST["key"]) )
			die('{"status":-1,"msg":"params missing"}');

		$key = $_REQUEST["key"];

		if( !is_string( $key ) || ( strlen($key) > 0 && !ctype_alnum( $key ) ) ) //avoid using the key to hack the system
			die('{"status":-1,"msg":"incorrect key"}');

		if( isset($_REQUEST["info"]) )
		{
			if( !hash_equals( (string)$KEY, $key ) ) //constant-time comparison
			{
				die('{"status":-1,"msg":"wrong key"}');
			}

			$token = md5(uniqid(rand(), true));
			$log_file = "deploy_" . $token . ".log";
			$info_filename = $BASE_DEPLOY_FOLDER . "/" . $token . ".json";
			$data = $_REQUEST["info"];
			if( !is_dir( $BASE_DEPLOY_FOLDER ) )
				mkdir( $BASE_DEPLOY_FOLDER, 0774, true );
			$temp = fopen( $info_filename, "w" );
			fwrite( $temp, $data );
			fclose( $temp );
			if(!file_exists( $info_filename ))
				die('{"status":-1,"msg":"error, no writing privileges in destination folder"}');
			$output = shell_exec('nohup php -q deployer.php '.escapeshellarg($info_filename).' >> '.escapeshellarg($log_file).' 2>&1 &');
			die('{"status":1,"msg":"processing","token":"'.$token.'"}');
		}
		die('{"status":0,"msg":"nothing"}');
	}

	if( count($argv) < 2 )
		die("missing info\nDONE\n");

	if( empty($BASE_DEPLOY_FOLDER) || !is_string($BASE_DEPLOY_FOLDER) )
		die("ERROR: BASE_DEPLOY_FOLDER not set in config.php\nDONE\n");

	$input_filename = $argv[1];
	echo "Input file: ". $input_filename ."\n";
	if(!file_exists( $input_filename ))
		die("file info not found\nDONE\n");
	$info_data = file_get_contents( $input_filename );
	unlink( $input_filename ); //remove json, it lives inside the (possibly public) deploy folder
	$info = json_decode($info_data);
	if($info == null)
		die("ERROR: file is not a valid json: ".$input_filename."\nDONE\n");

	//collapse duplicated slashes and leading slash, then validate
	function normalizeRelativePath( $path )
	{
		if( !is_string($path) )
			return null;
		return ltrim( preg_replace( '#/+#', '/', $path ), "/" );
	}

	$files_to_download = ( isset($info->files) && is_array($info->files) ) ? $info->files : array();
	$base_path = isset($info->base_path) ? $info->base_path : "";
	if( !is_string($base_path) || !preg_match( '#^https?://#i', $base_path ) )
		die("ERROR: base_path must be an http/https URL\nDONE\n");

	//avoid weird hacks to store files outside of deploy folder
	$project_folder_name = normalizeRelativePath( isset($info->project_folder) ? $info->project_folder : "" );
	if( !isSafeRelativePath( $project_folder_name, true ) )
		die("ERROR: project folder not valid\nDONE\n");

	$scene_path = normalizeRelativePath( isset($info->scene) ? $info->scene : null );
	if( !isSafeRelativePath( $scene_path ) )
		die("ERROR: scene path not valid\nDONE\n");
	$info->scene = $scene_path;

	$project_folder = $BASE_DEPLOY_FOLDER . "/" . $project_folder_name;

	//DOWNLOAD DATA
	if( !is_dir( $project_folder ) )
		mkdir( $project_folder, 0774, true );
	echo " - Downloading SCENE: " . $info->scene . "...";
	if( downloadFile( $base_path . "/" . $info->scene, $project_folder . "/scene.json" ) )
		echo " [OK]\n";
	else
		echo " [ERROR]\n";

	for( $i = 0; $i < count( $files_to_download ); $i++ )
	{
		$filename = normalizeRelativePath( $files_to_download[$i] );
		if( !isSafeRelativePath( $filename ) || hasForbiddenExtension( $filename ) )
		{
			echo " - Skipping unsafe file: " . json_encode( $files_to_download[$i] ) . " [ERROR]\n";
			continue;
		}
		$folder = $project_folder . "/" . dirname( $filename );
		if( !is_dir( $folder ) )
			mkdir( $folder, 0774, true );
		echo " - Downloading: " . $filename . "...";
		if(!downloadFile( $base_path . "/" . $filename,  $project_folder . "/" . $filename ))
			echo " [ERROR]\n";
		else
			echo " [OK]\n";
	}

	echo "DONE\n";
?>
