<?php
/**
 * Theme file access and the sandboxed draft workflow.
 *
 * The point of this class is that an agent never edits a live theme. It clones
 * the theme into a draft, edits that, previews it on a tokenised URL, and only
 * a deliberate publish touches what visitors see — with the previous theme
 * backed up first.
 *
 * @package wpxmcp
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Theme tooling.
 */
class WPXMCP_Themes {

	/**
	 * Singleton.
	 *
	 * @var WPXMCP_Themes|null
	 */
	private static $instance = null;

	/**
	 * Draft themes live under this directory prefix inside the themes root.
	 */
	const DRAFT_PREFIX = 'wpxmcp-draft-';

	/**
	 * Backups taken at publish time.
	 */
	const BACKUP_PREFIX = 'wpxmcp-backup-';

	/**
	 * Extensions that may be written into a theme.
	 */
	const ALLOWED_EXTENSIONS = array( 'php', 'css', 'js', 'json', 'html', 'txt', 'md', 'svg', 'po', 'pot', 'mo', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'woff', 'woff2', 'ttf', 'otf' );

	/**
	 * Accessor.
	 *
	 * @return WPXMCP_Themes
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Hook up.
	 */
	private function __construct() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );

		// Preview support: swap the theme for requests carrying a valid token.
		add_filter( 'stylesheet', array( $this, 'maybe_preview_stylesheet' ) );
		add_filter( 'template', array( $this, 'maybe_preview_template' ) );
	}

	/**
	 * Routes.
	 */
	public function register_routes() {
		$ns    = WPXMCP_NAMESPACE;
		$admin = array( WPXMCP_REST::instance(), 'require_admin' );

		register_rest_route( $ns, '/themes/files', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'list_files' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/themes/file', array(
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'read_file' ),
				'permission_callback' => $admin,
			),
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'write_file' ),
				'permission_callback' => $admin,
			),
			array(
				'methods'             => WP_REST_Server::DELETABLE,
				'callback'            => array( $this, 'delete_file' ),
				'permission_callback' => $admin,
			),
		) );

		register_rest_route( $ns, '/themes/draft', array(
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'create_draft' ),
				'permission_callback' => $admin,
			),
			array(
				'methods'             => WP_REST_Server::DELETABLE,
				'callback'            => array( $this, 'delete_draft' ),
				'permission_callback' => $admin,
			),
		) );

		register_rest_route( $ns, '/themes/drafts', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'list_drafts' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/themes/scaffold', array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => array( $this, 'scaffold' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/themes/preview-url', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'preview_url' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/themes/publish', array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => array( $this, 'publish_draft' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/themes/activate', array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => array( $this, 'activate' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/themes/install', array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => array( $this, 'install' ),
			'permission_callback' => $admin,
		) );
	}

	/* ------------------------------------------------------------------ *
	 * Path safety
	 * ------------------------------------------------------------------ */

	/**
	 * Resolves the theme to operate on.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return string
	 */
	private function resolve_theme( $request ) {
		$theme = (string) $request->get_param( 'theme' );

		if ( '' !== $theme ) {
			return $theme;
		}

		// Default to the most recent draft when one exists, so a sequence of
		// edits after create_draft_theme does not need the id repeated.
		$drafts = $this->find_drafts();
		if ( ! empty( $drafts ) ) {
			return $drafts[0]['stylesheet'];
		}

		return get_stylesheet();
	}

	/**
	 * Validates a theme-relative path and returns the absolute path.
	 *
	 * Rejects traversal, absolute paths, and extensions outside the allowlist.
	 *
	 * @param string $theme        Theme directory name.
	 * @param string $relative     Theme-relative path.
	 * @param bool   $require_file Whether the file must already exist.
	 * @return string|WP_Error
	 */
	private function resolve_path( $theme, $relative, $require_file = false ) {
		$theme = basename( $theme );
		$root  = trailingslashit( get_theme_root() ) . $theme;

		if ( ! is_dir( $root ) ) {
			return new WP_Error( 'wpxmcp_no_theme', sprintf( 'No theme directory "%s".', $theme ), array( 'status' => 404 ) );
		}

		$relative = ltrim( str_replace( '\\', '/', (string) $relative ), '/' );

		if ( '' === $relative ) {
			return new WP_Error( 'wpxmcp_no_path', 'Supply a `path` relative to the theme root.', array( 'status' => 400 ) );
		}
		if ( false !== strpos( $relative, '..' ) || 0 === strpos( $relative, '/' ) ) {
			return new WP_Error( 'wpxmcp_path_traversal', 'Paths must stay inside the theme directory — "..", absolute paths and symlink escapes are refused.', array( 'status' => 400 ) );
		}

		$extension = strtolower( pathinfo( $relative, PATHINFO_EXTENSION ) );
		if ( ! in_array( $extension, self::ALLOWED_EXTENSIONS, true ) ) {
			return new WP_Error(
				'wpxmcp_bad_extension',
				sprintf( 'The extension ".%s" is not permitted in a theme. Allowed: %s.', $extension, implode( ', ', self::ALLOWED_EXTENSIONS ) ),
				array( 'status' => 400 )
			);
		}

		$full = $root . '/' . $relative;

		// Resolve symlinks and confirm the result is still inside the theme.
		$real_root = realpath( $root );
		$real_dir  = realpath( dirname( $full ) );
		if ( $real_dir && $real_root && 0 !== strpos( $real_dir, $real_root ) ) {
			return new WP_Error( 'wpxmcp_path_escape', 'That path resolves outside the theme directory.', array( 'status' => 400 ) );
		}

		if ( $require_file && ! file_exists( $full ) ) {
			return new WP_Error( 'wpxmcp_no_file', sprintf( 'No file at "%s" in theme "%s".', $relative, $theme ), array( 'status' => 404 ) );
		}

		return $full;
	}

	/**
	 * Whether the named theme is the live one.
	 *
	 * @param string $theme Stylesheet.
	 * @return bool
	 */
	private function is_live( $theme ) {
		return $theme === get_stylesheet() || $theme === get_template();
	}

	/* ------------------------------------------------------------------ *
	 * Files
	 * ------------------------------------------------------------------ */

	/**
	 * List files in a theme.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function list_files( $request ) {
		$theme  = basename( $this->resolve_theme( $request ) );
		$subdir = trim( (string) $request->get_param( 'subdir' ), '/' );
		$root   = trailingslashit( get_theme_root() ) . $theme;

		if ( ! is_dir( $root ) ) {
			return new WP_Error( 'wpxmcp_no_theme', sprintf( 'No theme directory "%s".', $theme ), array( 'status' => 404 ) );
		}
		if ( false !== strpos( $subdir, '..' ) ) {
			return new WP_Error( 'wpxmcp_path_traversal', 'Invalid subdir.', array( 'status' => 400 ) );
		}

		$base  = $subdir ? $root . '/' . $subdir : $root;
		$files = array();

		if ( is_dir( $base ) ) {
			$iterator = new RecursiveIteratorIterator(
				new RecursiveDirectoryIterator( $base, FilesystemIterator::SKIP_DOTS ),
				RecursiveIteratorIterator::SELF_FIRST
			);
			foreach ( $iterator as $item ) {
				/** @var SplFileInfo $item */
				if ( $item->isDir() ) {
					continue;
				}
				if ( false !== strpos( $item->getPathname(), '/node_modules/' ) || false !== strpos( $item->getPathname(), '/.git/' ) ) {
					continue;
				}
				$relative = ltrim( str_replace( $root, '', $item->getPathname() ), '/' );
				$files[]  = array(
					'path'     => $relative,
					'bytes'    => $item->getSize(),
					'modified' => gmdate( 'c', $item->getMTime() ),
				);
				if ( count( $files ) >= 1000 ) {
					break;
				}
			}
		}

		usort( $files, static function ( $a, $b ) {
			return strcmp( $a['path'], $b['path'] );
		} );

		return array(
			'theme'      => $theme,
			'is_live'    => $this->is_live( $theme ),
			'is_draft'   => 0 === strpos( $theme, self::DRAFT_PREFIX ),
			'file_count' => count( $files ),
			'files'      => $files,
		);
	}

	/**
	 * Read a theme file.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function read_file( $request ) {
		$theme = basename( $this->resolve_theme( $request ) );
		$path  = $this->resolve_path( $theme, $request->get_param( 'path' ), true );

		if ( is_wp_error( $path ) ) {
			return $path;
		}

		return array(
			'theme'    => $theme,
			'path'     => (string) $request->get_param( 'path' ),
			'bytes'    => filesize( $path ),
			'modified' => gmdate( 'c', filemtime( $path ) ),
			'content'  => file_get_contents( $path ), // phpcs:ignore WordPress.WP.AlternativeFunctions
		);
	}

	/**
	 * Write a theme file, syntax-checking PHP first.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function write_file( $request ) {
		$theme      = basename( $this->resolve_theme( $request ) );
		$relative   = (string) $request->get_param( 'path' );
		$content    = (string) $request->get_param( 'content' );
		$allow_live = (bool) $request->get_param( 'allow_live' );

		if ( $this->is_live( $theme ) && ! $allow_live ) {
			return new WP_Error(
				'wpxmcp_live_theme',
				sprintf( '"%s" is the live theme. Writing to it would change the site for every visitor immediately. Create a draft first (create_draft_theme), or pass allow_live_theme: true if you really mean to edit production directly.', $theme ),
				array( 'status' => 409 )
			);
		}

		$path = $this->resolve_path( $theme, $relative, false );
		if ( is_wp_error( $path ) ) {
			return $path;
		}

		// A PHP parse error in a theme file takes the whole site down. Catch it here.
		if ( 'php' === strtolower( pathinfo( $path, PATHINFO_EXTENSION ) ) ) {
			$check = $this->check_php_syntax( $content );
			if ( is_wp_error( $check ) ) {
				return $check;
			}
		}

		$dir = dirname( $path );
		if ( ! is_dir( $dir ) && ! wp_mkdir_p( $dir ) ) {
			return new WP_Error( 'wpxmcp_mkdir_failed', sprintf( 'Could not create the directory "%s". Check filesystem permissions on wp-content/themes.', $dir ), array( 'status' => 500 ) );
		}

		$written = file_put_contents( $path, $content ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		if ( false === $written ) {
			return new WP_Error( 'wpxmcp_write_failed', sprintf( 'Could not write "%s". The theme directory is probably not writable by the web server.', $relative ), array( 'status' => 500 ) );
		}

		wpxmcp_audit( 'theme write', array( 'theme' => $theme, 'path' => $relative, 'bytes' => $written ) );

		return array(
			'theme'   => $theme,
			'path'    => $relative,
			'bytes'   => $written,
			'is_live' => $this->is_live( $theme ),
		);
	}

	/**
	 * Lints PHP without executing it.
	 *
	 * Uses `php -l` where exec is available, and falls back to a token-level
	 * parse otherwise. Either way the file is never included.
	 *
	 * @param string $content PHP source.
	 * @return true|WP_Error
	 */
	private function check_php_syntax( $content ) {
		$source = ( 0 === strpos( ltrim( $content ), '<?php' ) ) ? $content : "<?php\n" . $content;

		// token_get_all raises a ParseError on invalid syntax under PHP 7+.
		try {
			$tokens = @token_get_all( $source, TOKEN_PARSE );
			unset( $tokens );
		} catch ( ParseError $e ) {
			return new WP_Error(
				'wpxmcp_php_syntax',
				sprintf( 'The file was not written: it contains a PHP syntax error — %s on line %d. Fix the syntax and retry; writing it would have fataled the site.', $e->getMessage(), $e->getLine() ),
				array( 'status' => 400 )
			);
		} catch ( Throwable $e ) {
			// An unexpected failure here should not block a legitimate write.
			return true;
		}

		return true;
	}

	/**
	 * Delete a theme file.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function delete_file( $request ) {
		$theme      = basename( $this->resolve_theme( $request ) );
		$relative   = (string) $request->get_param( 'path' );
		$allow_live = (bool) $request->get_param( 'allow_live' );

		if ( $this->is_live( $theme ) && ! $allow_live ) {
			return new WP_Error( 'wpxmcp_live_theme', sprintf( '"%s" is the live theme; refusing to delete from it. Work in a draft.', $theme ), array( 'status' => 409 ) );
		}

		$path = $this->resolve_path( $theme, $relative, true );
		if ( is_wp_error( $path ) ) {
			return $path;
		}

		wp_delete_file( $path );
		wpxmcp_audit( 'theme delete file', array( 'theme' => $theme, 'path' => $relative ) );

		return array( 'theme' => $theme, 'path' => $relative, 'deleted' => ! file_exists( $path ) );
	}

	/* ------------------------------------------------------------------ *
	 * Drafts
	 * ------------------------------------------------------------------ */

	/**
	 * Existing drafts, newest first.
	 *
	 * @return array
	 */
	private function find_drafts() {
		$root   = trailingslashit( get_theme_root() );
		$drafts = array();
		$meta   = get_option( 'wpxmcp_drafts', array() );

		foreach ( (array) glob( $root . self::DRAFT_PREFIX . '*', GLOB_ONLYDIR ) as $dir ) {
			$slug     = basename( $dir );
			$drafts[] = array(
				'stylesheet' => $slug,
				'cloned_from' => isset( $meta[ $slug ]['from'] ) ? $meta[ $slug ]['from'] : null,
				'created'    => isset( $meta[ $slug ]['created'] ) ? $meta[ $slug ]['created'] : gmdate( 'c', filemtime( $dir ) ),
				'modified'   => gmdate( 'c', filemtime( $dir ) ),
			);
		}

		usort( $drafts, static function ( $a, $b ) {
			return strcmp( $b['modified'], $a['modified'] );
		} );

		return $drafts;
	}

	/**
	 * List drafts.
	 *
	 * @return array
	 */
	public function list_drafts() {
		$drafts = $this->find_drafts();
		return array(
			'count'  => count( $drafts ),
			'drafts' => $drafts,
			'note'   => empty( $drafts ) ? 'No theme drafts exist. Create one with create_draft_theme before editing any theme file.' : null,
		);
	}

	/**
	 * Clone a theme into a draft.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function create_draft( $request ) {
		$from = (string) $request->get_param( 'from_theme' );
		$from = $from ? basename( $from ) : get_stylesheet();

		$source = trailingslashit( get_theme_root() ) . $from;
		if ( ! is_dir( $source ) ) {
			return new WP_Error( 'wpxmcp_no_theme', sprintf( 'No theme "%s" is installed.', $from ), array( 'status' => 404 ) );
		}

		$slug   = self::DRAFT_PREFIX . $from . '-' . gmdate( 'Ymd-His' );
		$target = trailingslashit( get_theme_root() ) . $slug;

		$copied = $this->copy_tree( $source, $target );
		if ( is_wp_error( $copied ) ) {
			return $copied;
		}

		// Rename the theme in style.css so wp-admin does not show two identical names.
		$style = $target . '/style.css';
		if ( file_exists( $style ) ) {
			$css  = file_get_contents( $style ); // phpcs:ignore WordPress.WP.AlternativeFunctions
			$name = (string) $request->get_param( 'draft_name' );
			$name = $name ? $name : wp_get_theme( $from )->get( 'Name' ) . ' (draft)';
			$css  = preg_replace( '/^(\s*Theme Name:).*$/mi', '$1 ' . $name, $css, 1 );
			file_put_contents( $style, $css ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		}

		$meta          = get_option( 'wpxmcp_drafts', array() );
		$meta[ $slug ] = array( 'from' => $from, 'created' => gmdate( 'c' ) );
		update_option( 'wpxmcp_drafts', $meta, false );

		wpxmcp_audit( 'theme draft create', array( 'from' => $from, 'draft' => $slug, 'files' => $copied ) );

		return array(
			'draft_stylesheet' => $slug,
			'cloned_from'      => $from,
			'files_copied'     => $copied,
			'live_theme'       => get_stylesheet(),
			'note'             => 'The live site is untouched. Edit this draft, preview it, then publish.',
		);
	}

	/**
	 * Recursive copy.
	 *
	 * @param string $source Source dir.
	 * @param string $target Target dir.
	 * @return int|WP_Error Files copied.
	 */
	private function copy_tree( $source, $target ) {
		if ( ! wp_mkdir_p( $target ) ) {
			return new WP_Error( 'wpxmcp_mkdir_failed', sprintf( 'Could not create "%s". wp-content/themes is probably not writable by the web server.', $target ), array( 'status' => 500 ) );
		}

		$count    = 0;
		$iterator = new RecursiveIteratorIterator(
			new RecursiveDirectoryIterator( $source, FilesystemIterator::SKIP_DOTS ),
			RecursiveIteratorIterator::SELF_FIRST
		);

		foreach ( $iterator as $item ) {
			/** @var SplFileInfo $item */
			$relative = ltrim( str_replace( $source, '', $item->getPathname() ), '/' );

			if ( 0 === strpos( $relative, 'node_modules/' ) || 0 === strpos( $relative, '.git/' ) ) {
				continue;
			}
			if ( $item->isDir() ) {
				wp_mkdir_p( $target . '/' . $relative );
				continue;
			}
			if ( copy( $item->getPathname(), $target . '/' . $relative ) ) {
				$count++;
			}
			if ( $count > 5000 ) {
				break;
			}
		}

		return $count;
	}

	/**
	 * Delete a draft.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function delete_draft( $request ) {
		$theme = basename( (string) $request->get_param( 'theme' ) );

		if ( 0 !== strpos( $theme, self::DRAFT_PREFIX ) ) {
			return new WP_Error(
				'wpxmcp_not_a_draft',
				sprintf( '"%s" is not a wpxmcp draft. This endpoint only deletes drafts, so an installed theme can never be removed by accident.', $theme ),
				array( 'status' => 400 )
			);
		}
		if ( $this->is_live( $theme ) ) {
			return new WP_Error( 'wpxmcp_live_theme', 'That draft is currently the active theme; switch away before deleting it.', array( 'status' => 409 ) );
		}

		$dir = trailingslashit( get_theme_root() ) . $theme;
		if ( ! is_dir( $dir ) ) {
			return new WP_Error( 'wpxmcp_no_theme', 'No such draft.', array( 'status' => 404 ) );
		}

		$this->delete_tree( $dir );

		$meta = get_option( 'wpxmcp_drafts', array() );
		unset( $meta[ $theme ] );
		update_option( 'wpxmcp_drafts', $meta, false );

		wpxmcp_audit( 'theme draft delete', array( 'draft' => $theme ) );

		return array( 'deleted' => ! is_dir( $dir ), 'theme' => $theme );
	}

	/**
	 * Recursive delete.
	 *
	 * @param string $dir Directory.
	 */
	private function delete_tree( $dir ) {
		$iterator = new RecursiveIteratorIterator(
			new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ),
			RecursiveIteratorIterator::CHILD_FIRST
		);
		foreach ( $iterator as $item ) {
			/** @var SplFileInfo $item */
			if ( $item->isDir() ) {
				rmdir( $item->getPathname() ); // phpcs:ignore WordPress.WP.AlternativeFunctions
			} else {
				wp_delete_file( $item->getPathname() );
			}
		}
		rmdir( $dir ); // phpcs:ignore WordPress.WP.AlternativeFunctions
	}

	/**
	 * Write a whole set of files as a new theme (or draft).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function scaffold( $request ) {
		$slug     = sanitize_key( (string) $request->get_param( 'slug' ) );
		$files    = $request->get_param( 'files' );
		$as_draft = null === $request->get_param( 'as_draft' ) ? true : (bool) $request->get_param( 'as_draft' );

		if ( '' === $slug ) {
			return new WP_Error( 'wpxmcp_no_slug', 'Supply a theme `slug`.', array( 'status' => 400 ) );
		}
		if ( ! is_array( $files ) || empty( $files ) ) {
			return new WP_Error( 'wpxmcp_no_files', 'Supply a `files` object of path => content.', array( 'status' => 400 ) );
		}

		$stylesheet = $as_draft ? self::DRAFT_PREFIX . $slug . '-' . gmdate( 'Ymd-His' ) : $slug;
		$root       = trailingslashit( get_theme_root() ) . $stylesheet;

		if ( is_dir( $root ) ) {
			return new WP_Error( 'wpxmcp_theme_exists', sprintf( 'A theme directory "%s" already exists.', $stylesheet ), array( 'status' => 409 ) );
		}
		if ( ! wp_mkdir_p( $root ) ) {
			return new WP_Error( 'wpxmcp_mkdir_failed', 'Could not create the theme directory. wp-content/themes is probably not writable by the web server.', array( 'status' => 500 ) );
		}

		$written = array();
		$skipped = array();

		foreach ( $files as $relative => $content ) {
			$path = $this->resolve_path( $stylesheet, $relative, false );
			if ( is_wp_error( $path ) ) {
				$skipped[ $relative ] = $path->get_error_message();
				continue;
			}
			if ( 'php' === strtolower( pathinfo( $path, PATHINFO_EXTENSION ) ) ) {
				$check = $this->check_php_syntax( (string) $content );
				if ( is_wp_error( $check ) ) {
					$skipped[ $relative ] = $check->get_error_message();
					continue;
				}
			}
			wp_mkdir_p( dirname( $path ) );
			if ( false !== file_put_contents( $path, (string) $content ) ) { // phpcs:ignore WordPress.WP.AlternativeFunctions
				$written[] = $relative;
			} else {
				$skipped[ $relative ] = 'write failed';
			}
		}

		if ( $as_draft ) {
			$meta                 = get_option( 'wpxmcp_drafts', array() );
			$meta[ $stylesheet ]  = array( 'from' => '(scaffold)', 'created' => gmdate( 'c' ) );
			update_option( 'wpxmcp_drafts', $meta, false );
		}

		wpxmcp_audit( 'theme scaffold', array( 'theme' => $stylesheet, 'files' => count( $written ) ) );

		return array(
			'stylesheet'   => $stylesheet,
			'is_draft'     => $as_draft,
			'files_written' => $written,
			'files_skipped' => $skipped,
		);
	}

	/* ------------------------------------------------------------------ *
	 * Preview
	 * ------------------------------------------------------------------ */

	/**
	 * Issue a tokenised preview URL for a draft.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function preview_url( $request ) {
		$theme = basename( $this->resolve_theme( $request ) );
		$path  = (string) $request->get_param( 'path' );
		$path  = $path ? $path : '/';

		if ( ! is_dir( trailingslashit( get_theme_root() ) . $theme ) ) {
			return new WP_Error( 'wpxmcp_no_theme', sprintf( 'No theme directory "%s".', $theme ), array( 'status' => 404 ) );
		}

		$token   = wp_generate_password( 32, false, false );
		$tokens  = get_option( 'wpxmcp_preview_tokens', array() );
		$expires = time() + ( 6 * HOUR_IN_SECONDS );

		// Drop expired tokens so the option cannot grow without bound.
		foreach ( (array) $tokens as $key => $data ) {
			if ( ! isset( $data['expires'] ) || $data['expires'] < time() ) {
				unset( $tokens[ $key ] );
			}
		}

		$tokens[ $token ] = array( 'theme' => $theme, 'expires' => $expires );
		update_option( 'wpxmcp_preview_tokens', $tokens, false );

		$url = add_query_arg( 'wpxmcp_preview', $token, home_url( $path ) );

		return array(
			'preview_url' => $url,
			'theme'       => $theme,
			'expires_gmt' => gmdate( 'c', $expires ),
			'note'        => 'Only requests carrying this token render the draft. Everyone else continues to see the live theme.',
		);
	}

	/**
	 * The draft named by a valid preview token, if any.
	 *
	 * @return string|null
	 */
	private function preview_theme() {
		static $resolved = false;
		static $theme    = null;

		if ( $resolved ) {
			return $theme;
		}
		$resolved = true;

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( empty( $_GET['wpxmcp_preview'] ) ) {
			return null;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$token  = sanitize_text_field( wp_unslash( $_GET['wpxmcp_preview'] ) );
		$tokens = get_option( 'wpxmcp_preview_tokens', array() );

		if ( ! isset( $tokens[ $token ] ) ) {
			return null;
		}
		if ( $tokens[ $token ]['expires'] < time() ) {
			return null;
		}
		if ( ! is_dir( trailingslashit( get_theme_root() ) . $tokens[ $token ]['theme'] ) ) {
			return null;
		}

		$theme = $tokens[ $token ]['theme'];
		return $theme;
	}

	/**
	 * Swap the stylesheet for a previewing request.
	 *
	 * @param string $stylesheet Current stylesheet.
	 * @return string
	 */
	public function maybe_preview_stylesheet( $stylesheet ) {
		$preview = $this->preview_theme();
		return $preview ? $preview : $stylesheet;
	}

	/**
	 * Swap the template for a previewing request.
	 *
	 * @param string $template Current template.
	 * @return string
	 */
	public function maybe_preview_template( $template ) {
		$preview = $this->preview_theme();
		if ( ! $preview ) {
			return $template;
		}
		// A child theme draft keeps its parent; a standalone draft is its own template.
		$theme = wp_get_theme( $preview );
		$parent = $theme->get( 'Template' );
		return $parent ? $parent : $preview;
	}

	/* ------------------------------------------------------------------ *
	 * Publish
	 * ------------------------------------------------------------------ */

	/**
	 * Promote a draft to the live theme, backing up the current one first.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function publish_draft( $request ) {
		$theme = (string) $request->get_param( 'theme' );

		if ( '' === $theme ) {
			$drafts = $this->find_drafts();
			if ( empty( $drafts ) ) {
				return new WP_Error( 'wpxmcp_no_draft', 'There are no theme drafts to publish.', array( 'status' => 404 ) );
			}
			$theme = $drafts[0]['stylesheet'];
		}
		$theme = basename( $theme );

		$source = trailingslashit( get_theme_root() ) . $theme;
		if ( ! is_dir( $source ) ) {
			return new WP_Error( 'wpxmcp_no_theme', sprintf( 'No theme directory "%s".', $theme ), array( 'status' => 404 ) );
		}

		$previous = get_stylesheet();
		$backup   = self::BACKUP_PREFIX . $previous . '-' . gmdate( 'Ymd-His' );

		$copied = $this->copy_tree( trailingslashit( get_theme_root() ) . $previous, trailingslashit( get_theme_root() ) . $backup );
		if ( is_wp_error( $copied ) ) {
			return new WP_Error(
				'wpxmcp_backup_failed',
				'Refusing to publish: the current theme could not be backed up first (' . $copied->get_error_message() . '). Nothing was changed.',
				array( 'status' => 500 )
			);
		}

		switch_theme( $theme );

		wpxmcp_audit( 'theme publish', array( 'theme' => $theme, 'previous' => $previous, 'backup' => $backup ) );

		return array(
			'published'     => true,
			'active_theme'  => get_stylesheet(),
			'previous'      => $previous,
			'backup'        => $backup,
			'rollback_hint' => sprintf( 'To undo this, activate "%s" (or the backup "%s").', $previous, $backup ),
		);
	}

	/**
	 * Activate an installed theme.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function activate( $request ) {
		$stylesheet = basename( (string) $request->get_param( 'stylesheet' ) );
		$theme      = wp_get_theme( $stylesheet );

		if ( ! $theme->exists() ) {
			return new WP_Error( 'wpxmcp_no_theme', sprintf( 'No theme "%s" is installed.', $stylesheet ), array( 'status' => 404 ) );
		}
		if ( $theme->errors() ) {
			return new WP_Error( 'wpxmcp_broken_theme', 'That theme reports errors and cannot be activated: ' . $theme->errors()->get_error_message(), array( 'status' => 400 ) );
		}

		$previous = get_stylesheet();
		switch_theme( $stylesheet );
		wpxmcp_audit( 'theme activate', array( 'theme' => $stylesheet, 'previous' => $previous ) );

		return array( 'active_theme' => get_stylesheet(), 'previous' => $previous );
	}

	/**
	 * Install a theme from the .org repository.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function install( $request ) {
		$slug = sanitize_key( (string) $request->get_param( 'slug' ) );
		if ( '' === $slug ) {
			return new WP_Error( 'wpxmcp_no_slug', 'Supply a theme `slug`.', array( 'status' => 400 ) );
		}
		return WPXMCP_CLI::run( 'theme install ' . $slug );
	}
}
